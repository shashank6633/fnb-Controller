// Akan Menu — root app, state + routing
const { useState: useS, useEffect: useE, useMemo: useM, useCallback } = React;

function App() {
  const [route, setRoute] = useS({ name: 'landing' });
  const [stack, setStack] = useS([]);
  const [tab, setTab] = useS('menu');
  const [section, setSection] = useS('food');
  const [cart, setCart] = useS({});
  const [tableOpen, setTableOpen] = useS(false);
  const TABLE = 12;

  // Navigation helpers
  const go = (r) => {
    setStack(s => route.name === 'landing' ? s : [...s, route]);
    setRoute(r);
  };
  const back = (subOverride) => {
    if (typeof subOverride === 'string') {
      // from subcategory "continue browsing"
      setRoute({ name: 'sub', subId: subOverride });
      return;
    }
    if (stack.length === 0) {
      setRoute({ name: 'home' });
    } else {
      const prev = stack[stack.length - 1];
      setStack(stack.slice(0, -1));
      setRoute(prev);
    }
  };

  // Cart
  const cartCount = Object.values(cart).reduce((n, x) => n + x.qty, 0);
  const addToCart = (item, q = 1) => {
    setCart(c => ({ ...c, [item.id]: { item, qty: (c[item.id]?.qty || 0) + q } }));
  };
  const inc = (id) => setCart(c => ({ ...c, [id]: { ...c[id], qty: c[id].qty + 1 } }));
  const dec = (id) => setCart(c => {
    const cur = c[id];
    if (!cur) return c;
    if (cur.qty <= 1) {
      const { [id]: _, ...rest } = c; return rest;
    }
    return { ...c, [id]: { ...cur, qty: cur.qty - 1 } };
  });
  const remove = (id) => setCart(c => { const { [id]: _, ...r } = c; return r; });

  // Tab → route (don't run on landing — that screen has its own CTA)
  useE(() => {
    if (route.name === 'landing') return;
    if (tab === 'menu' && route.name !== 'home' && route.name !== 'sub' && route.name !== 'item') {
      setStack([]); setRoute({ name: 'home' });
    }
    if (tab === 'search' && route.name !== 'search') setRoute({ name: 'search' });
    if (tab === 'cart' && route.name !== 'cart' && route.name !== 'placed') setRoute({ name: 'cart' });
  }, [tab]);

  // Sync tab from route
  useE(() => {
    if (route.name === 'search') setTab('search');
    else if (route.name === 'cart' || route.name === 'placed') setTab('cart');
    else if (route.name === 'home' || route.name === 'sub' || route.name === 'item') setTab('menu');
  }, [route.name]);

  const { Landing, MenuHome, Subcategory, ItemDetail, SearchScreen, Cart, Placed, TableSheet, BottomNav } = window.Akan;

  let screen;
  if (route.name === 'landing') {
    screen = <Landing onEnter={() => { setStack([]); setRoute({ name: 'home' }); }} />;
  } else if (route.name === 'home') {
    screen = <MenuHome
      section={section} setSection={setSection}
      onOpenSub={(subId, itemId) => {
        if (itemId) {
          const item = MENU[section].sub.find(s => s.id === subId)?.items.find(i => i.id === itemId);
          if (item) { setStack(s => [...s, { name: 'home' }]); setRoute({ name: 'item', item }); return; }
        }
        go({ name: 'sub', subId });
      }}
      onOpenSearch={() => go({ name: 'search' })}
      onOpenTable={() => setTableOpen(true)}
      table={TABLE}
    />;
  } else if (route.name === 'sub') {
    screen = <Subcategory
      section={section} subId={route.subId}
      onBack={back}
      onOpenItem={(item) => go({ name: 'item', item })}
      onOpenSearch={() => go({ name: 'search' })}
      cart={cart} addToCart={addToCart} inc={inc} dec={dec}
    />;
  } else if (route.name === 'item') {
    screen = <ItemDetail
      item={route.item} onBack={back}
      qty={cart[route.item.id]?.qty || 0}
      addToCart={(item, q) => { addToCart(item, q); back(); }}
      inc={inc} dec={dec}
      onOpenPair={(it) => { setRoute({ name: 'item', item: it }); }}
    />;
  } else if (route.name === 'search') {
    screen = <SearchScreen
      onClose={() => { if (stack.length > 0) back(); else { setRoute({ name: 'home' }); } }}
      onOpenItem={(item) => go({ name: 'item', item })}
      cart={cart} addToCart={addToCart} inc={inc} dec={dec}
    />;
  } else if (route.name === 'cart') {
    screen = <Cart
      cart={cart} inc={inc} dec={dec} remove={remove}
      onBack={() => { setRoute({ name: 'home' }); setStack([]); }}
      onPlaced={(total) => setRoute({ name: 'placed', total })}
      table={TABLE}
    />;
  } else if (route.name === 'placed') {
    screen = <Placed
      total={route.total}
      onContinue={() => { setCart({}); setRoute({ name: 'home' }); setStack([]); }}
      onTable={() => setTableOpen(true)}
      table={TABLE}
    />;
  }

  // Hide bottom nav on landing
  const showNav = route.name !== 'landing';
  // Hide nav when search screen is full overlay (still keep visible for consistency? hide for focus)
  const showSearch = route.name === 'search';

  return (
    <IOSDevice width={402} height={874}>
      <div style={{
        position: 'relative', width: '100%', height: '100%',
        overflow: 'hidden', background: window.C.paper,
      }}>
        <div style={{
          position: 'absolute', inset: 0, overflow: 'auto',
          paddingBottom: showNav ? 0 : 0,
        }}>
          {screen}
        </div>
        {showNav && !showSearch && (
          <BottomNav tab={tab} setTab={setTab} cartCount={cartCount} onTable={() => setTableOpen(true)} />
        )}
        <TableSheet open={tableOpen} onClose={() => setTableOpen(false)} table={TABLE} />
      </div>
    </IOSDevice>
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App />);
