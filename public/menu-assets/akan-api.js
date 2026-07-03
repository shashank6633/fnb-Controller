/*
 * Akan Menu — backend adapter (NOT a design file).
 *
 * The design app (ios-frame/atoms/taste-map/screens/app .jsx) is reused byte-for-
 * byte except three surgical wiring hooks:
 *   • app.jsx     — TABLE reads window.AKAN_TABLE (the scanned table)
 *   • screens.jsx — Cart "Place order" calls window.AkanAPI.placeOrder(...)
 *   • screens.jsx — TableSheet bell calls window.AkanAPI.serviceRequest(...)
 *
 * This adapter owns everything else: read the QR token, fetch the live menu +
 * table from the public /api/customer/* endpoints, expose window.AkanAPI, and
 * boot the app (compile the JSX in-browser via Babel, in the original order,
 * only after the data is ready).
 */
(function () {
  var ASSETS = '/menu-assets/';
  var UI_FILES = ['ios-frame.jsx', 'atoms.jsx', 'taste-map.jsx', 'screens.jsx']; // define globals
  var APP_FILE = 'app.jsx';                                                       // renders the app

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  var token = qs('t') || qs('table') || '';

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || 'Request failed');
        return j;
      });
    });
  }

  // ── public API used by the (otherwise untouched) design components ──────────
  window.AkanAPI = {
    token: token,
    placeOrder: function (items) {
      return postJSON('/api/customer/orders', { t: token, items: items });
    },
    serviceRequest: function (type) {
      // Fire-and-forget: the UI already shows an optimistic "on its way".
      return postJSON('/api/customer/service-requests', { t: token, type: type })
        .catch(function () { /* keep the optimistic UI even if the ping fails */ });
    },
    toast: function (msg) { showToast(msg); },
  };

  // ── tiny, design-agnostic helpers (only ever seen on error) ─────────────────
  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
      'max-width:82%', 'z-index:9999', 'background:#2D4A3A', 'color:#FBF4DF',
      'font:500 13.5px Geist,system-ui,sans-serif', 'padding:12px 18px',
      'border-radius:999px', 'box-shadow:0 8px 30px rgba(0,0,0,0.35)', 'text-align:center',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  function showFatal(title, body) {
    var stage = document.getElementById('stage');
    if (stage) stage.style.transform = 'scale(1)';
    var o = document.createElement('div');
    o.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9998', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'text-align:center', 'padding:32px',
      'color:#FBF4DF', 'font-family:Geist,system-ui,sans-serif',
    ].join(';');
    // Colours below are the exact QR-menu design tokens (atoms.jsx C): card #FBF4DF
    // for the title, a soft warm paper tint for the body — on the dark #1F1A14 body.
    o.innerHTML =
      '<div style="font-family:\'Instrument Serif\',serif;font-size:34px;line-height:1.05;margin-bottom:10px;color:#FBF4DF">' + title + '</div>' +
      '<div style="font-family:\'Geist\',system-ui,sans-serif;font-size:14.5px;line-height:1.5;color:#E9C6AB;max-width:340px">' + body + '</div>';
    document.body.appendChild(o);
  }

  function compileAndRun(code) {
    var out = Babel.transform(code, { presets: ['react'] }).code;
    var s = document.createElement('script');
    s.textContent = out;
    document.body.appendChild(s);
  }

  function fetchText(u) {
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('Failed to load ' + u);
      return r.text();
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  function boot() {
    if (!token) {
      showFatal('Scan to view the menu', 'Please scan the QR code on your table to open the menu and order.');
      return;
    }
    // Fetch the compiled-later JSX in parallel; fetch the menu; then compile in order.
    Promise.all(UI_FILES.map(function (f) { return fetchText(ASSETS + f); }))
      .then(function (uiCodes) {
        return fetch('/api/customer/menu?t=' + encodeURIComponent(token))
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
          .then(function (res) {
            if (res.status === 404) {
              showFatal('Table not found', 'This QR code isn’t linked to a table yet. Please ask our staff for help.');
              return;
            }
            if (!res.j || res.j.ok === false) throw new Error((res.j && res.j.error) || 'Menu unavailable');

            // Inject live data BEFORE the app renders (bare MENU resolves to window.MENU).
            window.MENU = res.j.menu;
            window.AKAN_TABLE = res.j.table;
            window.AKAN_BRAND = res.j.brand;

            uiCodes.forEach(compileAndRun);                 // define components/globals
            return fetchText(ASSETS + APP_FILE).then(compileAndRun); // render
          });
      })
      .catch(function (e) {
        console.error('[akan-menu] boot failed', e);
        showFatal('Menu unavailable', 'We couldn’t load the menu just now. Please check your connection and try again.');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
