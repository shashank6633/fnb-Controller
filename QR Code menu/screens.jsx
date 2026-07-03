// Akan Menu — main app
// Uses atoms from window: C, VegDot, SpiceMeter, Badge, Rupee, Photo, Icon, PaperRule, Chip

const { useState, useEffect, useMemo, useRef } = React;

// ──────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────
function allItems(menu) {
  const out = [];
  Object.entries(menu).forEach(([sec, secData]) =>
    secData.sub.forEach(s =>
      s.items.forEach(i => out.push({ ...i, section: sec, sub: s.id, subName: s.name }))
    )
  );
  return out;
}
const FMT = n => n.toLocaleString('en-IN');

// ──────────────────────────────────────────────────────────
// Akan wordmark
// ──────────────────────────────────────────────────────────
function Wordmark({ size = 44, color = C.ink, sub = true }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{
        fontFamily: '"Instrument Serif", serif',
        fontSize: size, lineHeight: 0.9, color, letterSpacing: -1,
        fontStyle: 'italic', fontWeight: 400,
      }}>Akan</div>
      {sub && (
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 3,
          textTransform: 'uppercase', color: C.inkMute,
        }}>· Hyderabad ·</div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// LANDING — QR scan welcome
// ──────────────────────────────────────────────────────────
function Landing({ onEnter }) {
  return (
    <div style={{
      width: '100%', height: '100%', background: C.paper,
      display: 'flex', flexDirection: 'column', color: C.ink,
      paddingTop: 64, // status bar
    }}>
      {/* top decorative band */}
      <div style={{ padding: '12px 22px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
          textTransform: 'uppercase', color: C.inkMute,
        }}>Est. 2019</div>
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
          textTransform: 'uppercase', color: C.inkMute,
        }}>Banjara Hills</div>
      </div>

      {/* hero illustrative photo placeholder */}
      <div style={{ padding: '28px 22px 0' }}>
        <div style={{ position: 'relative' }}>
          <Photo name="Akan dining room" hue={28} ratio="4/5" radius={6} label={false} />
          {/* overlay wordmark */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', justifyContent: 'space-between', padding: 22,
          }}>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
              color: '#FFF1DA', opacity: 0.85,
            }}>FIG. 01 — DINING ROOM</div>

            <div style={{ alignSelf: 'flex-start' }}>
              <div style={{
                fontFamily: '"Instrument Serif", serif',
                fontSize: 108, lineHeight: 0.85, fontStyle: 'italic',
                color: C.paper, letterSpacing: -3,
              }}>Akan</div>
              <div style={{
                fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 2.5,
                textTransform: 'uppercase', color: '#FFF1DA', marginTop: 6,
              }}>— a café, Hyderabad —</div>
            </div>
          </div>
        </div>
      </div>

      {/* welcome copy */}
      <div style={{ padding: '24px 26px 0' }}>
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
          textTransform: 'uppercase', color: C.terra, fontWeight: 500,
        }}>You're seated at</div>
        <div style={{
          fontFamily: '"Instrument Serif", serif', fontSize: 38, lineHeight: 1,
          color: C.ink, marginTop: 4,
        }}>Table No. 12</div>
        <div style={{
          fontFamily: 'Geist, sans-serif', fontSize: 14, lineHeight: 1.45,
          color: C.inkSoft, marginTop: 10, maxWidth: 300,
        }}>Welcome. Take your time — browse the menu, save favourites,
        and order whenever you're ready.</div>
      </div>

      {/* CTA */}
      <div style={{ marginTop: 'auto', padding: '0 22px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button onClick={onEnter} style={{
          height: 56, borderRadius: 999, border: 'none',
          background: C.ink, color: C.paper, cursor: 'pointer',
          fontFamily: 'Geist, sans-serif', fontSize: 15, fontWeight: 500,
          letterSpacing: 0.2, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8,
        }}>
          View Menu
          <Icon.chevR s={16} c={C.paper} />
        </button>
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 9.5, letterSpacing: 1.4,
          textTransform: 'uppercase', color: C.inkMute, textAlign: 'center',
        }}>Scanned at 7:42 PM · Tap anytime for service</div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// HEADER (back, title, right-action)
// ──────────────────────────────────────────────────────────
function Header({ onBack, title, eyebrow, right }) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: C.paper,
      borderBottom: `1px solid ${C.rule}`,
      padding: '54px 18px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {onBack && (
          <button onClick={onBack} style={{
            width: 36, height: 36, borderRadius: 999, border: `1px solid ${C.rule}`,
            background: 'transparent', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', color: C.ink, flex: 'none',
          }}><Icon.back s={18} /></button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {eyebrow && (
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9.5, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute, marginBottom: 1,
            }}>{eyebrow}</div>
          )}
          <div style={{
            fontFamily: '"Instrument Serif", serif', fontSize: 24, lineHeight: 1.05,
            color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
        </div>
        {right}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// HOME — section tabs + subcategory tiles
// ──────────────────────────────────────────────────────────
function MenuHome({ section, setSection, onOpenSub, onOpenSearch, onOpenTable, table }) {
  const data = MENU[section];
  return (
    <div style={{ background: C.paper, paddingBottom: 120, minHeight: '100%' }}>
      {/* Top bar with wordmark + table */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10, background: C.paper,
        paddingTop: 54, paddingBottom: 10,
      }}>
        <div style={{ padding: '0 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{
              fontFamily: '"Instrument Serif", serif', fontSize: 26, lineHeight: 1,
              color: C.ink, fontStyle: 'italic',
            }}>Akan</span>
            <span style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 2,
              textTransform: 'uppercase', color: C.inkMute, marginTop: 2,
            }}>Hyderabad</span>
          </div>
          <button onClick={onOpenTable} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px 7px 10px',
            borderRadius: 999, border: `1px solid ${C.rule}`,
            background: C.cardElev, cursor: 'pointer',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: C.terra,
              boxShadow: `0 0 0 3px ${C.terra}22`,
            }} />
            <span style={{
              fontFamily: 'Geist, sans-serif', fontSize: 12, fontWeight: 500, color: C.ink,
            }}>Table {table}</span>
          </button>
        </div>

        {/* Search trigger */}
        <div style={{ padding: '14px 22px 0' }}>
          <button onClick={onOpenSearch} style={{
            width: '100%', height: 44, borderRadius: 12,
            background: C.card, border: `1px solid ${C.rule}`,
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '0 14px', cursor: 'pointer', color: C.inkMute,
            fontFamily: 'Geist, sans-serif', fontSize: 14,
          }}>
            <Icon.search s={18} c={C.inkSoft} />
            <span>Search "biryani", "lassi"…</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon.filter s={16} c={C.inkSoft} />
            </span>
          </button>
        </div>

        {/* Section tabs */}
        <div style={{ display: 'flex', gap: 6, padding: '14px 22px 0' }}>
          {Object.entries(MENU).map(([k, v]) => {
            const a = section === k;
            return (
              <button key={k} onClick={() => setSection(k)} style={{
                flex: 1, height: 40, borderRadius: 10,
                border: `1px solid ${a ? C.ink : C.rule}`,
                background: a ? C.ink : 'transparent',
                color: a ? C.paper : C.ink, cursor: 'pointer',
                fontFamily: '"Instrument Serif", serif', fontSize: 17,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8,
              }}>
                <span>{v.label}</span>
                <span style={{
                  fontFamily: 'Geist Mono, monospace', fontSize: 10,
                  opacity: a ? 0.7 : 0.5, marginTop: 1,
                }}>{v.sub.reduce((n, s) => n + s.items.length, 0)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Section eyebrow */}
      <div style={{ padding: '18px 22px 10px' }}>
        <PaperRule mono>{section === 'food' ? 'Kitchen · 22 dishes' : 'Bar · 14 drinks'}</PaperRule>
      </div>

      {/* Subcategory tiles */}
      <div style={{ padding: '0 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {data.sub.map((s, i) => (
          <button key={s.id} onClick={() => onOpenSub(s.id)} style={{
            background: C.card, border: `1px solid ${C.rule}`,
            borderRadius: 14, padding: 10, textAlign: 'left',
            cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <Photo name={s.name} hue={s.items[0]?.hue || 30} ratio="4/3" radius={8} label={false} />
            <div style={{ padding: '0 2px 2px' }}>
              <div style={{
                fontFamily: '"Instrument Serif", serif', fontSize: 19, lineHeight: 1.1, color: C.ink,
              }}>{s.name}</div>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginTop: 4,
              }}>
                <span style={{
                  fontFamily: 'Geist Mono, monospace', fontSize: 10, color: C.inkMute,
                  letterSpacing: 0.6, textTransform: 'uppercase',
                }}>{s.items.length} items</span>
                <Icon.chevR s={14} c={C.inkMute} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Chef recommends strip */}
      <div style={{ padding: '28px 0 0' }}>
        <div style={{ padding: '0 22px 10px' }}>
          <PaperRule mono>Chef recommends</PaperRule>
        </div>
        <div style={{
          display: 'flex', gap: 12, padding: '0 22px',
          overflowX: 'auto', scrollSnapType: 'x mandatory',
        }}>
          {allItems(MENU).filter(i => i.tags.includes('chef')).slice(0, 5).map(i => (
            <button key={i.id} onClick={() => onOpenSub(i.sub, i.id)} style={{
              flex: '0 0 168px', scrollSnapAlign: 'start',
              background: C.card, border: `1px solid ${C.rule}`, borderRadius: 14,
              padding: 10, textAlign: 'left', cursor: 'pointer',
            }}>
              <Photo name={i.name} hue={i.hue} ratio="1/1" radius={8} label={false} />
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5, marginTop: 8,
              }}>
                <VegDot kind={i.veg} size={10} />
                <span style={{
                  fontFamily: 'Geist Mono, monospace', fontSize: 9, color: C.inkMute,
                  letterSpacing: 0.6, textTransform: 'uppercase',
                }}>{i.subName}</span>
              </div>
              <div style={{
                fontFamily: '"Instrument Serif", serif', fontSize: 16, lineHeight: 1.15,
                color: C.ink, marginTop: 2, height: 38, overflow: 'hidden',
              }}>{i.name}</div>
              <Rupee amount={i.price} size={12.5} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// ITEM ROW (within category listing)
// ──────────────────────────────────────────────────────────
function ItemRow({ item, qty, onOpen, onAdd, onInc, onDec }) {
  return (
    <button onClick={onOpen} style={{
      width: '100%', textAlign: 'left', background: 'transparent',
      border: 'none', padding: '14px 0', cursor: 'pointer',
      display: 'flex', gap: 14, alignItems: 'flex-start',
      borderBottom: `1px solid ${C.ruleSoft}`,
    }}>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap', rowGap: 4 }}>
          <VegDot kind={item.veg} />
          <SpiceMeter level={item.spice} />
          {item.tags.includes('popular') && <Badge kind="popular" />}
          {item.tags.includes('chef') && <Badge kind="chef" />}
        </div>
        <div style={{
          fontFamily: '"Instrument Serif", serif', fontSize: 19, lineHeight: 1.15, color: C.ink,
        }}>{item.name}</div>
        <div style={{
          fontFamily: 'Geist, sans-serif', fontSize: 12.5, lineHeight: 1.4,
          color: C.inkSoft, marginTop: 4, display: '-webkit-box',
          WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden',
        }}>{item.desc}</div>
        <div style={{ marginTop: 8 }}>
          <Rupee amount={item.price} size={14} />
        </div>
      </div>

      <div style={{ position: 'relative', flex: 'none', width: 104 }}>
        <Photo name={item.name} hue={item.hue} ratio="1/1" radius={10} label={false} />
        {/* Add / qty control */}
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute', bottom: -10, left: '50%', transform: 'translateX(-50%)',
        }}>
          {qty > 0 ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 0,
              background: C.terra, color: C.paper, borderRadius: 999,
              boxShadow: '0 6px 16px rgba(180, 80, 46, 0.35)',
              border: `1px solid ${C.terraDeep}`,
            }}>
              <button onClick={(e) => { e.stopPropagation(); onDec(); }} style={{
                width: 30, height: 30, borderRadius: '50%', border: 'none',
                background: 'transparent', color: C.paper, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icon.minus s={14} c={C.paper} /></button>
              <span style={{
                fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 600,
                minWidth: 14, textAlign: 'center',
              }}>{qty}</span>
              <button onClick={(e) => { e.stopPropagation(); onInc(); }} style={{
                width: 30, height: 30, borderRadius: '50%', border: 'none',
                background: 'transparent', color: C.paper, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icon.plus s={14} c={C.paper} /></button>
            </div>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onAdd(); }} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 30, padding: '0 12px 0 10px',
              borderRadius: 999, border: `1px solid ${C.terra}`,
              background: C.paper, color: C.terra, cursor: 'pointer',
              fontFamily: 'Geist, sans-serif', fontSize: 12, fontWeight: 600,
              letterSpacing: 0.4, textTransform: 'uppercase',
              boxShadow: '0 4px 10px rgba(35,28,18,0.10)',
            }}>
              <Icon.plus s={12} c={C.terra} />
              Add
            </button>
          )}
        </div>
      </div>
    </button>
  );
}

// ──────────────────────────────────────────────────────────
// SUBCATEGORY listing
// ──────────────────────────────────────────────────────────
function Subcategory({ section, subId, onBack, onOpenItem, onOpenSearch, cart, addToCart, inc, dec }) {
  const data = MENU[section].sub.find(s => s.id === subId);
  const otherSubs = MENU[section].sub.filter(s => s.id !== subId);
  return (
    <div style={{ background: C.paper, minHeight: '100%', paddingBottom: 140 }}>
      <Header
        onBack={onBack}
        eyebrow={MENU[section].label}
        title={data.name}
        right={(
          <button onClick={onOpenSearch} style={{
            width: 36, height: 36, borderRadius: 999, border: `1px solid ${C.rule}`,
            background: 'transparent', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', color: C.ink,
          }}><Icon.search s={16} /></button>
        )}
      />
      {/* blurb */}
      <div style={{ padding: '14px 22px 0' }}>
        <div style={{
          fontFamily: '"Instrument Serif", serif', fontStyle: 'italic',
          fontSize: 15, lineHeight: 1.4, color: C.inkSoft,
        }}>{data.blurb}</div>
      </div>

      {/* items */}
      <div style={{ padding: '8px 22px 0' }}>
        {data.items.map(item => (
          <ItemRow
            key={item.id}
            item={item}
            qty={cart[item.id]?.qty || 0}
            onOpen={() => onOpenItem(item)}
            onAdd={() => addToCart(item)}
            onInc={() => inc(item.id)}
            onDec={() => dec(item.id)}
          />
        ))}
      </div>

      {/* other subcategory pills */}
      <div style={{ marginTop: 24 }}>
        <div style={{ padding: '0 22px 10px' }}>
          <PaperRule mono>Continue browsing</PaperRule>
        </div>
        <div style={{
          display: 'flex', gap: 8, padding: '0 22px', overflowX: 'auto',
        }}>
          {otherSubs.map(s => (
            <button key={s.id} onClick={() => onBack(s.id)} style={{
              flex: 'none', padding: '8px 14px', borderRadius: 999,
              background: C.card, border: `1px solid ${C.rule}`,
              fontFamily: 'Geist, sans-serif', fontSize: 12.5, color: C.ink,
              cursor: 'pointer',
            }}>{s.name} <span style={{ color: C.inkMute }}>· {s.items.length}</span></button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// ITEM DETAIL
// ──────────────────────────────────────────────────────────
function ItemDetail({ item, onBack, qty, addToCart, inc, dec, onOpenPair }) {
  const [localQty, setLocalQty] = useState(Math.max(1, qty));
  useEffect(() => { setLocalQty(Math.max(1, qty || 1)); }, [item.id]);
  const total = item.price * localQty;
  return (
    <div style={{ background: C.paper, minHeight: '100%', paddingBottom: 140 }}>
      {/* Hero */}
      <div style={{ position: 'relative' }}>
        <Photo name={item.name} hue={item.hue} ratio="1/1" radius={0} label={false} style={{ borderRadius: 0 }} />
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          padding: '54px 18px 12px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button onClick={onBack} style={{
            width: 38, height: 38, borderRadius: 999, border: 'none',
            background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: C.ink,
          }}><Icon.back s={18} /></button>
        </div>
        {/* corner fig label */}
        <div style={{
          position: 'absolute', left: 18, bottom: 14,
          fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.6,
          textTransform: 'uppercase', color: '#FFF1DA', opacity: 0.85,
          background: 'rgba(0,0,0,0.28)', padding: '4px 8px', borderRadius: 3,
        }}>Fig. · {item.subName} · img</div>
      </div>

      {/* body */}
      <div style={{ padding: '22px 22px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <VegDot kind={item.veg} size={13} />
          <SpiceMeter level={item.spice} size={12} />
          {item.tags.includes('popular') && <Badge kind="popular" />}
          {item.tags.includes('chef') && <Badge kind="chef" />}
        </div>
        <h1 style={{
          fontFamily: '"Instrument Serif", serif', fontSize: 34, lineHeight: 1.1,
          color: C.ink, margin: 0, marginTop: 10, fontWeight: 400,
        }}>{item.name}</h1>
        <div style={{
          fontFamily: 'Geist, sans-serif', fontSize: 14.5, lineHeight: 1.5,
          color: C.inkSoft, marginTop: 12,
        }}>{item.desc}.</div>

        {/* Taste map */}
        <div style={{ marginTop: 22 }}>
          <PaperRule mono>Taste profile</PaperRule>
          <div style={{
            marginTop: 12,
            background: C.card, border: `1px solid ${C.rule}`, borderRadius: 14,
            padding: '8px 8px 4px',
            display: 'flex', justifyContent: 'center',
          }}>
            <TasteMap taste={item.taste || { sour: 0, sweet: 0, spicy: 0, tangy: 0 }} size={210} />
          </div>
        </div>

        {/* Pairs nicely with */}
        {item.pairs && item.pairs.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <PaperRule mono>Pairs nicely with</PaperRule>
            <div style={{ marginTop: 12 }}>
              <PairsWith pairs={item.pairs} onOpen={onOpenPair} />
            </div>
          </div>
        )}

        {/* meta */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
          marginTop: 22, padding: '14px 4px', borderTop: `1px solid ${C.rule}`,
          borderBottom: `1px solid ${C.rule}`,
        }}>
          <div>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>Spice</div>
            <div style={{
              fontFamily: 'Geist, sans-serif', fontSize: 13, color: C.ink, marginTop: 2,
            }}>{['None', 'Mild', 'Medium', 'Hot'][item.spice]}</div>
          </div>
          <div>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>Diet</div>
            <div style={{
              fontFamily: 'Geist, sans-serif', fontSize: 13, color: C.ink, marginTop: 2,
            }}>{item.veg === 'v' ? 'Vegetarian' : item.veg === 'e' ? 'Contains egg' : 'Non-vegetarian'}</div>
          </div>
          <div>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>Serves</div>
            <div style={{
              fontFamily: 'Geist, sans-serif', fontSize: 13, color: C.ink, marginTop: 2,
            }}>1 — 2 people</div>
          </div>
          <div>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>Prep</div>
            <div style={{
              fontFamily: 'Geist, sans-serif', fontSize: 13, color: C.ink, marginTop: 2,
            }}>~ 18 minutes</div>
          </div>
        </div>

        {/* notes */}
        <div style={{
          marginTop: 20,
          background: C.card, border: `1px solid ${C.rule}`,
          borderRadius: 12, padding: 14,
        }}>
          <div style={{
            fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 1.4,
            textTransform: 'uppercase', color: C.inkMute, marginBottom: 6,
          }}>Special request</div>
          <div style={{
            fontFamily: 'Geist, sans-serif', fontSize: 13.5, color: C.inkSoft,
          }}>e.g. Less spicy, no onion, extra raita…</div>
        </div>
      </div>

      {/* sticky CTA */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 60,
        padding: '14px 16px 14px', background: C.paper,
        borderTop: `1px solid ${C.rule}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        {/* qty stepper */}
        <div style={{
          display: 'inline-flex', alignItems: 'center',
          height: 50, border: `1px solid ${C.rule}`, borderRadius: 999,
          background: C.cardElev,
        }}>
          <button onClick={() => setLocalQty(q => Math.max(1, q - 1))} style={{
            width: 44, height: 50, border: 'none', background: 'transparent',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon.minus s={16} c={C.ink} /></button>
          <span style={{
            fontFamily: 'Geist Mono, monospace', fontSize: 15, fontWeight: 600,
            minWidth: 20, textAlign: 'center', color: C.ink,
          }}>{localQty}</span>
          <button onClick={() => setLocalQty(q => q + 1)} style={{
            width: 44, height: 50, border: 'none', background: 'transparent',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon.plus s={16} c={C.ink} /></button>
        </div>
        <button onClick={() => addToCart(item, localQty)} style={{
          flex: 1, height: 50, borderRadius: 999, border: 'none',
          background: C.terra, color: C.paper, cursor: 'pointer',
          fontFamily: 'Geist, sans-serif', fontSize: 14.5, fontWeight: 500,
          letterSpacing: 0.2, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 20px',
        }}>
          <span>Add to order</span>
          <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>
            ₹{FMT(total)}
          </span>
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// SEARCH overlay
// ──────────────────────────────────────────────────────────
function SearchScreen({ onClose, onOpenItem, addToCart, cart, inc, dec }) {
  const [q, setQ] = useState('');
  const [veg, setVeg] = useState('all'); // all | v | n
  const [spice, setSpice] = useState(0); // 0 | 1 | 2 | 3 max
  const items = useMemo(() => allItems(MENU), []);

  const filtered = items.filter(it => {
    const matchQ = !q || it.name.toLowerCase().includes(q.toLowerCase()) || it.desc.toLowerCase().includes(q.toLowerCase());
    const matchV = veg === 'all' || (veg === 'v' && it.veg === 'v') || (veg === 'n' && it.veg === 'n');
    const matchS = spice === 0 || it.spice <= spice;
    return matchQ && matchV && matchS;
  });

  return (
    <div style={{ background: C.paper, minHeight: '100%', paddingBottom: 100 }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 10, background: C.paper,
        padding: '54px 18px 12px', borderBottom: `1px solid ${C.rule}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 10,
            height: 44, borderRadius: 12, background: C.card,
            border: `1px solid ${C.rule}`, padding: '0 14px',
          }}>
            <Icon.search s={18} c={C.inkSoft} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search the menu"
              style={{
                flex: 1, border: 'none', outline: 'none', background: 'transparent',
                fontFamily: 'Geist, sans-serif', fontSize: 14, color: C.ink,
              }} />
            {q && <button onClick={() => setQ('')} style={{
              border: 'none', background: 'transparent', cursor: 'pointer', color: C.inkMute,
            }}><Icon.close s={16} c={C.inkMute} /></button>}
          </div>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: 'Geist, sans-serif', fontSize: 14, color: C.ink, fontWeight: 500,
          }}>Cancel</button>
        </div>

        {/* filter row */}
        <div style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto', paddingBottom: 2 }}>
          <Chip active={veg === 'all'} onClick={() => setVeg('all')}>All</Chip>
          <Chip active={veg === 'v'} onClick={() => setVeg('v')}>
            <VegDot kind="v" size={10} /> Veg
          </Chip>
          <Chip active={veg === 'n'} onClick={() => setVeg('n')}>
            <VegDot kind="n" size={10} /> Non-veg
          </Chip>
          <span style={{ width: 1, background: C.rule, margin: '0 4px' }} />
          <Chip active={spice === 0} onClick={() => setSpice(0)}>Any spice</Chip>
          <Chip active={spice === 1} onClick={() => setSpice(1)}>≤ Mild</Chip>
          <Chip active={spice === 2} onClick={() => setSpice(2)}>≤ Medium</Chip>
        </div>
      </div>

      {/* results */}
      <div style={{ padding: '8px 22px 0' }}>
        {q === '' && (
          <div style={{ padding: '14px 0 4px' }}>
            <PaperRule mono>Try one of these</PaperRule>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {['Biryani', 'Filter Coffee', 'Paneer', 'Mocktail', 'Tiramisu'].map(s => (
                <button key={s} onClick={() => setQ(s)} style={{
                  padding: '7px 12px', borderRadius: 999,
                  background: C.card, border: `1px solid ${C.rule}`,
                  fontFamily: '"Instrument Serif", serif', fontStyle: 'italic',
                  fontSize: 14, color: C.ink, cursor: 'pointer',
                }}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {q !== '' && (
          <div style={{ padding: '10px 0 4px' }}>
            <div style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>{filtered.length} result{filtered.length !== 1 ? 's' : ''}</div>
          </div>
        )}
        {filtered.map(item => (
          <ItemRow
            key={item.id}
            item={item}
            qty={cart[item.id]?.qty || 0}
            onOpen={() => onOpenItem(item)}
            onAdd={() => addToCart(item)}
            onInc={() => inc(item.id)}
            onDec={() => dec(item.id)}
          />
        ))}
        {q !== '' && filtered.length === 0 && (
          <div style={{
            padding: '40px 0', textAlign: 'center', color: C.inkMute,
            fontFamily: '"Instrument Serif", serif', fontStyle: 'italic', fontSize: 18,
          }}>No dishes match "{q}"</div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// CART / Order
// ──────────────────────────────────────────────────────────
function Cart({ cart, inc, dec, remove, onBack, onPlaced, table }) {
  const items = Object.values(cart);
  const subtotal = items.reduce((s, i) => s + i.item.price * i.qty, 0);
  const gst = Math.round(subtotal * 0.05);
  const service = Math.round(subtotal * 0.10);
  const total = subtotal + gst + service;
  const [placing, setPlacing] = useState(false);

  return (
    <div style={{ background: C.paper, minHeight: '100%', paddingBottom: 220 }}>
      <Header onBack={onBack} eyebrow={`Table ${table}`} title="Your order" />
      {items.length === 0 ? (
        <div style={{ padding: '60px 22px', textAlign: 'center' }}>
          <Icon.bag s={32} c={C.inkMute} />
          <div style={{
            fontFamily: '"Instrument Serif", serif', fontSize: 24, color: C.ink, marginTop: 14,
          }}>Nothing here yet</div>
          <div style={{
            fontFamily: 'Geist, sans-serif', fontSize: 13.5, color: C.inkSoft, marginTop: 6,
          }}>Browse the menu and add a few things to get started.</div>
        </div>
      ) : (
        <>
          <div style={{ padding: '14px 22px 0' }}>
            {items.map(({ item, qty }) => (
              <div key={item.id} style={{
                display: 'flex', gap: 12, alignItems: 'flex-start',
                padding: '12px 0', borderBottom: `1px solid ${C.ruleSoft}`,
              }}>
                <div style={{ width: 56, flex: 'none' }}>
                  <Photo name={item.name} hue={item.hue} ratio="1/1" radius={8} label={false} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <VegDot kind={item.veg} size={10} />
                    <span style={{
                      fontFamily: 'Geist Mono, monospace', fontSize: 9.5, letterSpacing: 0.6,
                      textTransform: 'uppercase', color: C.inkMute,
                    }}>{item.subName}</span>
                  </div>
                  <div style={{
                    fontFamily: '"Instrument Serif", serif', fontSize: 17, color: C.ink, marginTop: 2,
                  }}>{item.name}</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center',
                      border: `1px solid ${C.rule}`, borderRadius: 999, background: C.card,
                    }}>
                      <button onClick={() => dec(item.id)} style={{
                        width: 28, height: 28, border: 'none', background: 'transparent',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{qty === 1 ? <Icon.close s={12} c={C.ink} /> : <Icon.minus s={12} c={C.ink} />}</button>
                      <span style={{
                        fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 600,
                        minWidth: 16, textAlign: 'center', color: C.ink,
                      }}>{qty}</span>
                      <button onClick={() => inc(item.id)} style={{
                        width: 28, height: 28, border: 'none', background: 'transparent',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}><Icon.plus s={12} c={C.ink} /></button>
                    </div>
                    <span style={{ marginLeft: 'auto' }}>
                      <Rupee amount={FMT(item.price * qty)} size={13.5} />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* bill */}
          <div style={{ padding: '20px 22px 0' }}>
            <PaperRule mono>Bill summary</PaperRule>
            <div style={{
              marginTop: 12, background: C.card, border: `1px solid ${C.rule}`,
              borderRadius: 12, padding: 14,
              fontFamily: 'Geist, sans-serif', fontSize: 13.5, color: C.ink,
            }}>
              <BillRow label="Subtotal" v={subtotal} />
              <BillRow label="GST · 5%" v={gst} />
              <BillRow label="Service · 10%" v={service} />
              <div style={{ height: 1, background: C.rule, margin: '10px 0' }} />
              <BillRow label="Total" v={total} bold />
              <div style={{
                marginTop: 8, fontFamily: 'Geist Mono, monospace', fontSize: 9.5,
                letterSpacing: 1.2, textTransform: 'uppercase', color: C.inkMute,
              }}>Payable at table · cash, card, UPI</div>
            </div>
          </div>

          {/* CTA */}
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 60,
            padding: '14px 16px', background: C.paper,
            borderTop: `1px solid ${C.rule}`,
          }}>
            <button onClick={() => { setPlacing(true); setTimeout(() => onPlaced(total), 700); }}
              disabled={placing}
              style={{
                width: '100%', height: 56, borderRadius: 999, border: 'none',
                background: C.forest, color: C.paper, cursor: 'pointer',
                fontFamily: 'Geist, sans-serif', fontSize: 15, fontWeight: 500,
                letterSpacing: 0.2, display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', padding: '0 22px',
                opacity: placing ? 0.6 : 1,
              }}>
              <span>{placing ? 'Sending to kitchen…' : 'Place order'}</span>
              <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>
                ₹{FMT(total)}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
function BillRow({ label, v, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ color: bold ? C.ink : C.inkSoft, fontWeight: bold ? 600 : 400 }}>{label}</span>
      <span style={{
        fontFamily: 'Geist Mono, monospace', fontWeight: bold ? 600 : 500,
        fontVariantNumeric: 'tabular-nums',
      }}>₹{FMT(v)}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// PLACED — confirmation screen
// ──────────────────────────────────────────────────────────
function Placed({ total, onContinue, onTable, table }) {
  return (
    <div style={{
      background: C.paper, height: '100%', display: 'flex',
      flexDirection: 'column', paddingTop: 100,
    }}>
      <div style={{ padding: '0 26px' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: C.forest, color: C.paper,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon.check s={28} c={C.paper} /></div>
        <div style={{
          fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
          textTransform: 'uppercase', color: C.terra, marginTop: 28, fontWeight: 500,
        }}>Order placed · Table {table}</div>
        <div style={{
          fontFamily: '"Instrument Serif", serif', fontSize: 42, lineHeight: 1.05,
          color: C.ink, marginTop: 4,
        }}>Thank you.</div>
        <div style={{
          fontFamily: 'Geist, sans-serif', fontSize: 14, lineHeight: 1.5,
          color: C.inkSoft, marginTop: 12,
        }}>Your order is with the kitchen. You can keep adding —
        we'll bring everything together. Estimated time: ~ 22 minutes.</div>

        <div style={{
          marginTop: 24, background: C.card, border: `1px solid ${C.rule}`,
          borderRadius: 12, padding: 14,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{
              fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.4,
              textTransform: 'uppercase', color: C.inkMute,
            }}>Running tab</span>
            <Rupee amount={FMT(total)} size={20} />
          </div>
        </div>
      </div>
      <div style={{ marginTop: 'auto', padding: '0 22px 110px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button onClick={onContinue} style={{
          height: 52, borderRadius: 999, border: 'none',
          background: C.ink, color: C.paper, cursor: 'pointer',
          fontFamily: 'Geist, sans-serif', fontSize: 14.5, fontWeight: 500,
        }}>Add more to the order</button>
        <button onClick={onTable} style={{
          height: 52, borderRadius: 999, background: 'transparent',
          border: `1px solid ${C.rule}`, color: C.ink, cursor: 'pointer',
          fontFamily: 'Geist, sans-serif', fontSize: 14.5, fontWeight: 500,
        }}>Call waiter</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TABLE actions bottom-sheet
// ──────────────────────────────────────────────────────────
function TableSheet({ open, onClose, table }) {
  const [requested, setRequested] = useState(null);
  const actions = [
    { id: 'waiter', icon: Icon.waiter, label: 'Call waiter', sub: 'A server will be right over' },
    { id: 'water', icon: Icon.water, label: 'Refill water', sub: 'Still or sparkling — your call' },
    { id: 'cutlery', icon: Icon.spoon, label: 'Extra cutlery', sub: 'Spoons, forks, napkins' },
    { id: 'bill', icon: Icon.bill, label: 'Request bill', sub: 'We\'ll bring the cheque' },
  ];

  useEffect(() => {
    if (!open) setRequested(null);
  }, [open]);

  return (
    <>
      {/* scrim */}
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, zIndex: 40,
        background: 'rgba(20, 16, 10, 0.4)',
        opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 0.22s ease',
      }} />
      {/* sheet */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 50,
        background: C.paper, borderTopLeftRadius: 22, borderTopRightRadius: 22,
        boxShadow: '0 -10px 40px rgba(20,16,10,0.18)',
        transform: open ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)',
        paddingBottom: 28,
      }}>
        {/* grabber */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
          <div style={{ width: 38, height: 4, borderRadius: 4, background: C.rule }} />
        </div>

        <div style={{ padding: '14px 22px 0' }}>
          <div style={{
            fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: 1.6,
            textTransform: 'uppercase', color: C.terra, fontWeight: 500,
          }}>Table {table} · service</div>
          <div style={{
            fontFamily: '"Instrument Serif", serif', fontSize: 26, color: C.ink, marginTop: 2,
          }}>How can we help?</div>
        </div>

        <div style={{ padding: '16px 18px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {actions.map(a => {
            const sent = requested === a.id;
            return (
              <button key={a.id} onClick={() => setRequested(a.id)} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 14px', borderRadius: 14,
                background: sent ? C.forest : C.card,
                border: `1px solid ${sent ? C.forest : C.rule}`,
                color: sent ? C.paper : C.ink,
                cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.2s ease',
              }}>
                <span style={{
                  width: 42, height: 42, borderRadius: 999, flex: 'none',
                  background: sent ? 'rgba(255,255,255,0.15)' : C.paper,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: sent ? C.paper : C.terra,
                }}>
                  {sent ? <Icon.check s={20} c={C.paper} /> : <a.icon s={22} c={C.terra} />}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: '"Instrument Serif", serif', fontSize: 19, lineHeight: 1.1,
                  }}>{sent ? 'On its way' : a.label}</div>
                  <div style={{
                    fontFamily: 'Geist, sans-serif', fontSize: 12.5, lineHeight: 1.3,
                    color: sent ? 'rgba(255,255,255,0.75)' : C.inkSoft, marginTop: 2,
                  }}>{sent ? `We've notified your server.` : a.sub}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────
// BOTTOM NAV
// ──────────────────────────────────────────────────────────
function BottomNav({ tab, setTab, cartCount, onTable }) {
  const tabs = [
    { id: 'menu', icon: Icon.menu, label: 'Menu' },
    { id: 'search', icon: Icon.search, label: 'Search' },
    { id: 'cart', icon: Icon.bag, label: 'Order', count: cartCount },
  ];
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30,
      background: C.paper, borderTop: `1px solid ${C.rule}`,
      padding: '8px 14px 22px',
      display: 'flex', alignItems: 'center', gap: 4,
    }}>
      {tabs.map(t => {
        const a = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, height: 50, borderRadius: 12, border: 'none',
            background: 'transparent', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 2,
            color: a ? C.ink : C.inkMute, position: 'relative',
          }}>
            <span style={{ position: 'relative' }}>
              <t.icon s={22} c={a ? C.ink : C.inkMute} />
              {t.count > 0 && (
                <span style={{
                  position: 'absolute', top: -4, right: -8,
                  minWidth: 16, height: 16, padding: '0 4px',
                  borderRadius: 999, background: C.terra, color: C.paper,
                  fontFamily: 'Geist Mono, monospace', fontSize: 10, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{t.count}</span>
              )}
            </span>
            <span style={{
              fontFamily: 'Geist, sans-serif', fontSize: 10.5,
              fontWeight: a ? 600 : 500, letterSpacing: 0.2,
            }}>{t.label}</span>
          </button>
        );
      })}
      <button onClick={onTable} style={{
        flex: 1, height: 50, borderRadius: 12, border: 'none',
        background: 'transparent', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 2, color: C.inkMute,
      }}>
        <Icon.bell s={22} c={C.inkMute} />
        <span style={{
          fontFamily: 'Geist, sans-serif', fontSize: 10.5,
          fontWeight: 500, letterSpacing: 0.2,
        }}>Table</span>
      </button>
    </div>
  );
}

window.Akan = {
  Landing, MenuHome, Subcategory, ItemDetail, SearchScreen,
  Cart, Placed, TableSheet, BottomNav, Wordmark,
};
