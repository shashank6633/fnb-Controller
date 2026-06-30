# AKAN Captain — the installable tablet app

The Captain app lives **inside** F&B Controller (no separate codebase). It's a
mobile-first POS at `/captain` that reuses the dine-in APIs. It ships two ways:

1. **Installable PWA** — “Add to Home Screen” (works on any deployed HTTPS host).
2. **Signed Android APK (TWA)** — a real `.apk`/`.aab` you sideload or put on Play.
   **Already built** at `captain-android/AKAN-Captain-1.0.0.apk` (+ `.aab`).

Three printing facts to remember:
- The **captain tablet only fires** orders (it can't reach the on-counter print bridge).
- The **Print Agent** page (`/print/agent`) must be open on the **counter PC**
  (the one running the bridge). It listens over SSE and prints every fired KOT.
- The captain's **“Print bill at counter”** routes the bill to that same agent.

---

## ⚠️ Before the APK works: deploy Captain to production

The APK is just a wrapper that opens **`https://fnb.akanhyd.com/captain`**. It does
nothing useful until that URL serves the Captain app. The Captain code is on
**testing GCP** but **not yet on production AWS**. To ship to production (your
GitHub Action), commit + push these to `origin/main`:

```
src/app/captain/**                         # the tablet app
src/app/print/**                           # the counter print-agent
src/app/api/dine-in/orders/[id]/print-bill/**
src/lib/kds-bus.ts  src/lib/page-catalog.ts  src/proxy.ts  src/components/Sidebar.tsx
public/captain.webmanifest  public/captain-icon-*.png  public/captain-apple-touch.png
public/.well-known/assetlinks.json         # ← REQUIRED for full-screen (no URL bar)
```

`captain-android/` is **git-ignored for the keystore + binaries** (never commit the
signing key). After the deploy, verify:

```
curl -I https://fnb.akanhyd.com/captain                       # 307 -> /login (route exists)
curl    https://fnb.akanhyd.com/.well-known/assetlinks.json   # the JSON below, 200
```

If `assetlinks.json` is missing on production, the TWA still runs but shows a
Chrome address bar instead of full-screen.

---

## Install the APK on tablets (sideload)

1. Copy `captain-android/AKAN-Captain-1.0.0.apk` to the tablet (USB / Drive / link).
2. On the tablet: Settings → allow “Install unknown apps” for your file manager.
3. Open the APK → Install. It appears as **“Captain”** with the chef-hat icon and
   launches full-screen to `https://fnb.akanhyd.com/captain`.
4. Captains sign in once; the session persists.

(Or, no APK needed: open the site in Chrome → **Install** button in the Captain
top bar / Chrome menu → *Add to Home screen*. iPad/Safari: Share → *Add to Home
Screen*.)

> There is intentionally **no caching service worker** (the app ships a
> self-destructing SW to avoid stale-chunk bugs, and the offline print outbox
> uses IndexedDB, not an SW). The app needs network to load — fine for an
> on-prem POS on the venue Wi-Fi. A TWA does not require an SW.

---

## The signing key (keep it safe!)

- Keystore: `captain-android/android.keystore` (alias `captain`)
- Password + details: `captain-android/KEYSTORE_README.txt`
- **Both are git-ignored. Back them up somewhere safe** (password manager / secure
  drive). You need the SAME key for every future update, and its SHA-256 must keep
  matching `assetlinks.json`.

Cert SHA-256 (already in `public/.well-known/assetlinks.json`):
```
2E:8C:6F:16:22:9A:FF:E2:C1:AE:CB:04:42:4C:DA:64:E4:45:C8:FB:03:C8:F0:AC:12:67:8B:B6:60:F2:F5:48
```

---

## Rebuild the APK (e.g. new version)

Prereqs: **JDK 17** (Bubblewrap pins 17 — this machine used a downloaded Temurin
17; Android Studio's bundled JDK is 21 and Bubblewrap rejects it), the Android SDK
(`~/Library/Android/sdk`), and `@bubblewrap/cli` (installed globally).

`~/.bubblewrap/config.json` must point at a **JDK 17** bundle root + the SDK:
```json
{ "jdkPath": "<path-to-jdk-17 bundle, parent of Contents/Home>",
  "androidSdkPath": "/Users/<you>/Library/Android/sdk" }
```

Then, from `captain-android/`:
```bash
# bump version in twa-manifest.json (appVersionName / appVersionCode) and app/build.gradle
export BUBBLEWRAP_KEYSTORE_PASSWORD='<from KEYSTORE_README.txt>'
export BUBBLEWRAP_KEY_PASSWORD='<same>'
printf 'no\n' | bubblewrap build --skipPwaValidation   # 'no' = don't regenerate
# → app-release-signed.apk + app-release-bundle.aab
```

Note: `twa-manifest.json` sets `iconUrl` to `http://localhost:3001/...` so the icons
are pulled from the local dev server at generation time (they get baked into the
APK). Keep that dev server up if you ever fully regenerate. Runtime is unaffected —
it only ever opens `https://fnb.akanhyd.com/captain`.

## Play Store (optional)

Upload `AKAN-Captain-1.0.0.aab` to Play Console (internal testing track). Enrol in
**Play App Signing** — then add Google's app-signing SHA-256 (from the Play Console)
to `assetlinks.json` *in addition to* the upload-key fingerprint above.

---

## Files

| File | Purpose |
|---|---|
| `public/captain.webmanifest` | Captain PWA identity (id/start_url `/captain`, icons, theme) |
| `public/captain-*.png` | App icons (chef-hat) |
| `public/.well-known/assetlinks.json` | Digital Asset Links → full-screen TWA |
| `src/app/captain/layout.tsx` | Scopes the captain manifest to `/captain` only |
| `src/app/captain/page.tsx` | Home + in-app Install button |
| `src/proxy.ts` | Serves `*.webmanifest` + `assetlinks.json` publicly |
| `captain-android/` | The TWA Android project (Bubblewrap). Keystore/binaries git-ignored. |
