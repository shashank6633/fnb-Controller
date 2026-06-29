# F&B Controller — Local Print Bridge

Offline KOT + Bill printing for USB **and** network (IP) thermal printers.

## Why
A browser can't talk to a thermal printer directly, and when the internet is
down the cloud server is unreachable too. This tiny agent runs **on the billing
counter PC** so printing keeps working through an outage:

```
Browser (POS)  ──HTTP──▶  print-bridge (localhost:9920)  ──▶  printer
                                                       ├─ IP : raw TCP :9100
                                                       └─ USB: OS raw spool
```

Everything is on-site, so a 5‑minute internet drop never stops a ticket.

## Production: install as an always-on Windows Service (recommended)
On each counter PC, run **once** as Administrator — it auto-starts at boot,
self-heals on crash, needs no Node pre-installed, and the cashier never touches
a launcher again:

```powershell
# one-liner (downloads + installs the service + a daily auto-updater)
powershell -ExecutionPolicy Bypass -Command "irm https://fnb.akanhyd.com/install-bridge-service.ps1 -OutFile $env:TEMP\i.ps1; & $env:TEMP\i.ps1"
```

The service is named `AKANPrintBridge`. Manage it with the bundled NSSM:
`C:\AKAN\bridge\nssm.exe [start|stop|restart|status] AKANPrintBridge`.

## Dev / manual run
Needs **Node.js 18+**. Copy `print-bridge.mjs` to the counter PC and run:

```bash
node print-bridge.mjs
# options:
node print-bridge.mjs --port=9920 --origin=https://your-app-host
```

Leave the window open. In the app go to **Dine‑In → KOT & Bill Printers** and
click **Refresh** — the status turns green.

Keep it running automatically: add it to the OS startup (Windows Task Scheduler
"At log on", a macOS LaunchAgent, or a Linux systemd `--user` service).

## Configure printers (in the app UI)
- **Network (IP) printer** → target = `192.168.1.50:9100`
- **USB printer**:
  - **macOS/Linux** → target = the CUPS printer name (`lpstat -p` to list). The
    bridge sends raw bytes via `lp -d <name> -o raw`.
  - **Windows** → share the printer (Generic / Text Only driver) and use the
    share path, e.g. `\\localhost\POS80`. The bridge does `copy /b … <share>`.

Each printer is set to **Bill** or **KOT**, and 80mm (48 col) or 58mm (32 col).
Use **Test bill / Test KOT** to confirm before going live.

## Notes
- Zero dependencies; never touches the app database.
- HTTP on `localhost` is allowed from an HTTPS page (localhost is a secure
  context). A printer on a *different* machine over plain `http://<lan-ip>` would
  be blocked by the browser — keep the bridge on the same PC as the POS page.
