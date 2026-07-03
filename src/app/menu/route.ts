/**
 * GET /menu?t=<qr_token>   (PUBLIC — see src/proxy.ts isPublic)
 *
 * Serves the customer QR-menu shell. This is the design app's original
 * bootstrap (Akan Menu.html) with ONE change: instead of loading the JSX files
 * + hardcoded menu-data.js directly, it loads /menu-assets/akan-api.js, which
 * fetches the live menu/table from /api/customer/* and then compiles+runs the
 * (unmodified) design JSX. The look, fonts, and iOS-frame scaling are verbatim.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Akan · Menu</title>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">

<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #1F1A14;
    background-image:
      radial-gradient(circle at 18% 12%, rgba(180, 80, 46, 0.18), transparent 55%),
      radial-gradient(circle at 88% 88%, rgba(45, 74, 58, 0.22), transparent 55%);
    color: #fff;
    font-family: 'Geist', system-ui, sans-serif;
    min-height: 100%;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  #stage {
    transform-origin: 50% 50%;
    display: flex; align-items: center; justify-content: center;
  }
  /* hide native scrollbars inside the device */
  ::-webkit-scrollbar { width: 0; height: 0; }
  * { scrollbar-width: none; }

  /* Edges of placeholder image — keep crisp */
  img, svg { display: block; max-width: 100%; }

  /* Selection */
  ::selection { background: #B4502E; color: #FBF4DF; }
</style>
</head>
<body>
  <div id="stage"><div id="app"></div></div>

<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>

<!-- Backend adapter: reads ?t=<token>, fetches the live menu, then boots the design app. -->
<script src="/menu-assets/akan-api.js"></script>

<script>
  // Fit device to viewport (verbatim from the design bootstrap)
  (function fit() {
    const stage = document.getElementById('stage');
    const W = 402, H = 874, PAD = 40;
    function apply() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const target = (vw < 480)
        ? Math.min(vw / W, vh / H)
        : Math.min(1, (vw - PAD * 2) / W, (vh - PAD * 2) / H);
      stage.style.transform = \`scale(\${target.toFixed(4)})\`;
    }
    apply();
    window.addEventListener('resize', apply);
  })();
</script>
</body>
</html>`;

export function GET() {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
