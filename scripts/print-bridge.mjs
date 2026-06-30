#!/usr/bin/env node
/**
 * F&B Controller — Local Print Bridge (offline KOT + Bill printing)
 * ================================================================
 *
 * WHY THIS EXISTS
 *   A browser cannot open raw TCP/USB connections to a thermal printer, and when
 *   the internet is down the cloud server is unreachable too. So KOTs/bills can
 *   only keep printing through an outage if a small agent runs ON-SITE. This is
 *   that agent: it runs on the billing-counter PC, the POS page talks to it at
 *   http://localhost:9920 (allowed from an HTTPS page because localhost is a
 *   "secure context"), and it drives the printers directly over the LAN/USB.
 *
 *   Browser (POS)  ──HTTP──▶  this bridge (localhost)  ──▶  printer
 *                                                    ├─ IP  : raw TCP :9100
 *                                                    └─ USB : OS raw spool
 *
 *   Because every hop is on-site, a 5-minute internet outage doesn't stop a
 *   single ticket. (The browser-side IndexedDB outbox — added in Phase B —
 *   covers the case where the bridge/printer itself is briefly unreachable.)
 *
 * RUN IT (on the counter PC, no install / no dependencies — just Node ≥ 18):
 *     node scripts/print-bridge.mjs
 *     node scripts/print-bridge.mjs --port=9920 --origin=https://your-app-host
 *
 * Endpoints (all JSON, CORS-enabled for the configured origin):
 *     GET  /health                  → { ok, version, platform, uptimeSec }
 *     POST /print                   → { ok, jobId, bytes }   (prints a doc)
 *     POST /print?dryRun=1          → renders + returns byte count, does NOT print
 *
 * POST /print body:
 *   {
 *     "jobId":  "optional-client-id",
 *     "printer": { "transport": "ip" | "usb" | "file",
 *                  "target": "192.168.1.50:9100" | "POS-80" | "/tmp/out.bin",
 *                  "width": 48 },                      // 48=80mm, 32=58mm
 *     "doc": { "type": "kot" | "bill", ... }           // see renderers below
 *   }
 *
 * This file has ZERO dependencies and never touches the app or its database.
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VERSION = '2.1.0';   // 2.1.0 = per-line ordered KOT layout + Food/Liquor band + sized lines
const startedAt = Date.now();

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const PORT = Number(argVal('port', process.env.BRIDGE_PORT || 9920));
const HOST = argVal('host', process.env.BRIDGE_HOST || '127.0.0.1');
const ALLOW_ORIGIN = argVal('origin', process.env.BRIDGE_ALLOW_ORIGIN || '*');

// ── ESC/POS command bytes (same set proven by scripts/print-kot-test.mjs) ──
const ESC = 0x1b, GS = 0x1d;
const CMD = {
  init:        [ESC, 0x40],
  alignLeft:   [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  alignRight:  [ESC, 0x61, 0x02],
  boldOn:      [ESC, 0x45, 0x01],
  boldOff:     [ESC, 0x45, 0x00],
  dblOn:       [GS, 0x21, 0x11],   // double width + height
  dblOff:      [GS, 0x21, 0x00],
  feed3:       [ESC, 0x64, 0x03],
  cut:         [GS, 0x56, 0x00],   // full cut
};

function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

// Two-column line: left text, right text, padded to `cols`. Right is kept whole;
// left is trimmed with an ellipsis if the two would collide.
function twoCol(left, right, cols) {
  left = String(left ?? ''); right = String(right ?? '');
  const space = cols - right.length;
  if (left.length > space - 1) left = left.slice(0, Math.max(0, space - 2)) + '…';
  return left + ' '.repeat(Math.max(1, cols - left.length - right.length)) + right;
}

// ── Renderers: structured doc → ESC/POS byte buffer ──────────────────────────

// GS ! n character sizer: low nibble = height mult-1, high nibble = width mult-1.
// m=1 → 1x (0x00), m=2 → 2x (0x11), m=3 → 3x (0x22). Clamped to 1..4.
function sizeCmd(m) {
  const k = Math.max(1, Math.min(4, Math.round(m))) - 1;
  return [GS, 0x21, ((k << 4) | k) & 0xff];
}
const SIZE_MULT = { normal: 1, large: 2, xlarge: 3 };
const mult = (size) => SIZE_MULT[size] || 1;

// Default KOT line order (mirrors DEFAULT_KOT_LINES in src/lib/offline-print/
// print.ts) — used when a doc carries no `lines` (e.g. the master/expediter
// ticket) so an un-designed doc still prints the standard layout.
const DEFAULT_KOT_LINES = [
  { key: 'table', enabled: true, size: 'xlarge' },
  { key: 'outlet', enabled: true, size: 'large' },
  { key: 'floor', enabled: true, size: 'normal' },
  { key: 'kotNo', enabled: true, size: 'normal' },
  { key: 'copyLabel', enabled: true, size: 'large' },
  { key: 'foodLiquor', enabled: true, size: 'large' },
  { key: 'captain', enabled: true, size: 'normal' },
  { key: 'puncher', enabled: true, size: 'normal' },
  { key: 'dateTime', enabled: true, size: 'normal' },
  { key: 'headerNote', enabled: false, size: 'normal' },
  { key: 'items', enabled: true, size: 'normal' },
  { key: 'totalItems', enabled: true, size: 'normal' },
  { key: 'footerNote', enabled: false, size: 'normal' },
];

function buildKot(doc, cols, doCut) {
  const chunks = [];
  const push = (b) => chunks.push(Buffer.from(b));
  const line = (s = '') => chunks.push(Buffer.from(String(s) + '\n', 'ascii'));
  const rule = () => line('-'.repeat(cols));
  // Centered (optionally bold) line at size multiplier m.
  const center = (s, m, bold = true) => {
    push(CMD.alignCenter); if (bold) push(CMD.boldOn);
    if (m > 1) push(sizeCmd(m));
    line(s);
    if (m > 1) push(sizeCmd(1));
    if (bold) push(CMD.boldOff); push(CMD.alignLeft);
  };
  // Left-aligned line at size multiplier m.
  const left = (s, m, bold = false) => {
    if (bold) push(CMD.boldOn);
    if (m > 1) push(sizeCmd(m));
    line(s);
    if (m > 1) push(sizeCmd(1));
    if (bold) push(CMD.boldOff);
  };

  push(CMD.init);

  const cap = String(doc.captain || '').trim();
  const fb = String(doc.firedBy || '').trim();

  // One renderer per line key; each pulls its value off the doc and respects
  // the per-line size. Conditional lines no-op when their value is absent.
  const SECTIONS = {
    table:      (m) => center(doc.table ? `TABLE ${doc.table}` : String(doc.orderType || 'ORDER').toUpperCase(), m),
    outlet:     (m) => { if (doc.outletName) center(String(doc.outletName).toUpperCase(), m); },
    floor:      (m) => { if (doc.floor) center(`Floor: ${doc.floor}`, m, false); },
    kotNo:      (m) => center(`KOT${doc.kotNumber ? ` #${doc.kotNumber}` : ''}${doc.station ? ` - ${String(doc.station).toUpperCase()}` : ''}`, m),
    copyLabel:  (m) => { if (doc.copyLabel) center(doc.copyLabel, m); },
    foodLiquor: (m) => { if (doc.foodLiquor) center(`*** ${String(doc.foodLiquor).toUpperCase()} ***`, m); },
    captain:    (m) => { if (cap) left(`Captain: ${cap}`, m); },
    // Show the puncher ONLY when a DIFFERENT captain punched (case/space-insensitive).
    puncher:    (m) => { if (fb && fb.toLowerCase() !== cap.toLowerCase()) left(`Punched by: ${fb}`, m); },
    dateTime:   (m) => { if (doc.time != null) left(twoCol(fmtTime(doc.time), doc.orderRef ? `#${doc.orderRef}` : '', cols), m); },
    headerNote: (m) => { if (doc.headerNote) left(`* ${doc.headerNote} *`, m); },
    items:      (m) => {
      rule();
      const icols = Math.max(8, Math.floor(cols / Math.max(1, m)));
      for (const it of (doc.items || [])) {
        push(CMD.boldOn); if (m > 1) push(sizeCmd(m));
        line(twoCol(it.name || '', `x${it.qty ?? 1}`, icols));
        if (m > 1) push(sizeCmd(1));
        push(CMD.boldOff);
        for (const mo of (it.mods || it.modifiers || [])) line(`    + ${mo}`);
        if (it.notes) line(`    - ${it.notes}`);
      }
      rule();
    },
    totalItems: (m) => left(`Total items: ${(doc.items || []).reduce((s, it) => s + (Number(it.qty) || 1), 0)}`, m),
    footerNote: (m) => { if (doc.footerNote) { line(''); center(doc.footerNote, m, false); } },
  };

  const order = Array.isArray(doc.lines) && doc.lines.length ? doc.lines : DEFAULT_KOT_LINES;
  for (const ln of order) {
    const key = (ln && ln.key) || ln;            // tolerate {key,enabled,size} or a bare string
    if (ln && ln.enabled === false) continue;
    const fn = SECTIONS[key];
    if (fn) fn(mult((ln && ln.size) || 'normal'));
  }

  // Internal expediter banner (master ticket) — not user-configurable.
  if (doc.note) { line(''); push(CMD.alignCenter); push(CMD.boldOn); line(`** ${doc.note} **`); push(CMD.boldOff); push(CMD.alignLeft); }
  push(CMD.feed3);
  if (doCut) push(CMD.cut);
  return Buffer.concat(chunks);
}

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return 'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildBill(doc, cols, doCut) {
  const chunks = [];
  const push = (b) => chunks.push(Buffer.from(b));
  const line = (s = '') => chunks.push(Buffer.from(String(s) + '\n', 'ascii'));
  const rule = () => line('-'.repeat(cols));

  push(CMD.init);
  push(CMD.alignCenter); push(CMD.boldOn); push(CMD.dblOn);
  line((doc.shopName || 'RESTAURANT').toUpperCase());
  push(CMD.dblOff); push(CMD.boldOff);
  if (doc.address) line(doc.address);
  if (doc.gstin) line(`GSTIN: ${doc.gstin}`);
  if (doc.phone) line(`Ph: ${doc.phone}`);
  if (doc.headerNote) line(doc.headerNote);
  push(CMD.alignLeft);
  rule();
  line(twoCol(doc.billNo ? `Bill #${doc.billNo}` : 'Bill', doc.table ? `Table ${doc.table}` : '', cols));
  line(twoCol(fmtTime(doc.date), doc.server ? `Server: ${doc.server}` : '', cols));
  rule();
  // header
  line(twoCol('Item', 'Amount', cols));
  rule();
  for (const it of (doc.items || [])) {
    const qty = Number(it.qty) || 1;
    const price = Number(it.price) || 0;
    const amount = it.amount != null ? Number(it.amount) : qty * price;
    line(it.name || '');
    line(twoCol(`   ${qty} x ${money(price)}`, money(amount), cols));
  }
  rule();
  line(twoCol('Subtotal', money(doc.subtotal ?? (doc.items || []).reduce((s, it) => s + (it.amount != null ? Number(it.amount) : (Number(it.qty)||1) * (Number(it.price)||0)), 0)), cols));
  if (doc.discount) line(twoCol('Discount', '-' + money(doc.discount), cols));
  for (const t of (doc.tax || [])) line(twoCol(t.label || 'Tax', money(t.amount), cols));
  push(CMD.boldOn); push(CMD.dblOn);
  // double-width halves the columns, so render total on its own emphasized line
  line(twoCol('TOTAL', money(doc.total ?? 0), Math.floor(cols / 2)));
  push(CMD.dblOff); push(CMD.boldOff);
  rule();
  push(CMD.alignCenter);
  line(doc.footer || 'Thank you! Visit again.');
  push(CMD.alignLeft);
  push(CMD.feed3);
  if (doCut) push(CMD.cut);
  return Buffer.concat(chunks);
}

function render(doc, width) {
  const cols = Number(width) === 32 ? 32 : 48;
  const doCut = doc.cut !== false;
  if (doc.type === 'bill') return buildBill(doc, cols, doCut);
  return buildKot(doc, cols, doCut);   // default to KOT
}

// ── Transports: byte buffer → physical printer ───────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Query a network printer's real-time status via ESC/POS DLE EOT so we can tell
 * PAPER-OUT / COVER-OPEN / ERROR apart from merely "reachable". Never rejects —
 * resolves { reachable, supported, paperOut, paperLow, coverOpen, error }. A
 * printer that doesn't answer DLE EOT is reported supported:false (we then treat
 * it as printable, best-effort). Used by /printer-status (dashboard).
 */
function queryIpStatus(target, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const [host, portStr] = String(target).split(':');
    const port = Number(portStr) || 9100;
    const out = { reachable: false, supported: false, paperOut: false, paperLow: false, coverOpen: false, error: false };
    const bytes = [];
    let done = false;
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    const finish = () => {
      if (done) return; done = true; try { sock.destroy(); } catch {}
      if (bytes.length) {
        out.supported = true;
        const paper = bytes[0], offline = bytes[1];
        if (paper != null) { out.paperOut = (paper & 0x60) === 0x60; out.paperLow = (paper & 0x0c) !== 0; }
        if (offline != null) { out.coverOpen = (offline & 0x04) !== 0; if (offline & 0x20) out.paperOut = true; out.error = (offline & 0x40) !== 0; }
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on('connect', () => { out.reachable = true; sock.write(Buffer.from([0x10, 0x04, 0x04])); sock.write(Buffer.from([0x10, 0x04, 0x02])); });
    sock.on('data', (d) => { for (const b of d) bytes.push(b); if (bytes.length >= 2) { clearTimeout(timer); finish(); } });
    sock.on('error', () => { clearTimeout(timer); finish(); });
    sock.on('timeout', () => { clearTimeout(timer); finish(); });
  });
}

/**
 * Print to a network ESC/POS printer over raw TCP :9100. Before sending bytes we
 * ask the printer's status on the SAME connection — if it is OUT OF PAPER /
 * COVER OPEN / ERROR we REJECT (so the job stays queued + the dashboard flags
 * it) instead of silently "succeeding" when no paper comes out. Printers that
 * don't support DLE EOT just print (best-effort) after a short status wait.
 */
function printIp(target, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = String(target).split(':');
    const port = Number(portStr) || 9100;
    const gate = opts.gate !== false;
    const statusWait = opts.statusTimeout || 350;
    let phase = 'connect';
    const bytes = [];
    let timer = null;
    const sock = net.createConnection({ host, port, timeout: 6000 });
    const fail = (msg) => { if (timer) clearTimeout(timer); try { sock.destroy(); } catch {} reject(new Error(`printer ${host}:${port} — ${msg}`)); };
    const writePayload = () => { phase = 'print'; sock.write(payload, () => sock.end()); };
    const evaluate = () => {
      if (phase !== 'status') return;
      if (timer) clearTimeout(timer);
      const paper = bytes[0], offline = bytes[1];
      if (paper != null && (paper & 0x60) === 0x60) return fail('OUT OF PAPER');
      if (offline != null) {
        if (offline & 0x04) return fail('cover open');
        if (offline & 0x20) return fail('out of paper');
        if (offline & 0x40) return fail('printer error');
      }
      writePayload();
    };
    sock.on('connect', () => {
      if (!gate) return writePayload();
      phase = 'status';
      sock.write(Buffer.from([0x10, 0x04, 0x04]));   // DLE EOT 4 — paper sensor
      sock.write(Buffer.from([0x10, 0x04, 0x02]));   // DLE EOT 2 — offline cause
      timer = setTimeout(evaluate, statusWait);       // no/partial reply → print anyway
    });
    sock.on('data', (d) => { if (phase !== 'status') return; for (const b of d) bytes.push(b); if (bytes.length >= 2) evaluate(); });
    sock.on('error', (e) => { if (timer) clearTimeout(timer); reject(new Error(`printer ${host}:${port} — ${e.message}`)); });
    sock.on('timeout', () => { if (timer) clearTimeout(timer); try { sock.destroy(); } catch {} reject(new Error(`printer ${host}:${port} timed out`)); });
    sock.on('close', () => { if (phase === 'print') resolve(); });
  });
}

function printUsb(target, payload) {
  // Cross-platform raw spool to an OS-installed USB printer. No native deps.
  const plat = os.platform();
  if (plat === 'win32') {
    // target = a shared printer path, e.g. \\localhost\POS80  (share the printer
    // with that name, "Generic / Text Only" driver passes ESC/POS through raw).
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `fnb-kot-${Date.now()}.bin`);
      fs.writeFile(tmp, payload, (werr) => {
        if (werr) return reject(werr);
        const p = spawn('cmd', ['/c', 'copy', '/b', tmp, String(target)], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => { fs.unlink(tmp, () => {}); code === 0 ? resolve() : reject(new Error(`copy /b → ${target} failed (${code}) ${err}`)); });
        p.on('error', (e) => { fs.unlink(tmp, () => {}); reject(e); });
      });
    });
  }
  // macOS / Linux: target = CUPS printer name (lpstat -p). -o raw = pass bytes through.
  return new Promise((resolve, reject) => {
    const p = spawn('lp', ['-d', String(target), '-o', 'raw'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`lp -d ${target} failed (${code}) ${err.trim()}`))));
    p.on('error', (e) => reject(new Error(`lp not available — ${e.message}`)));
    p.stdin.write(payload);
    p.stdin.end();
  });
}

function printFile(target, payload) {            // for testing without a printer
  return fs.promises.writeFile(String(target || path.join(os.tmpdir(), 'fnb-print.bin')), payload);
}

// Retry connection-level failures (e.g. two counters hitting one printer at the
// same instant → busy/refused) with jitter. Definitive failures like OUT OF
// PAPER / cover open are NOT retried — they surface immediately to the queue.
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!/refused|timed out|ECONNREFUSED|EADDRINUSE|EHOSTUNREACH|ENETUNREACH|reset|EPIPE/i.test(e.message)) throw e;
      await sleep(60 + Math.floor(Math.random() * 140));
    }
  }
  throw last;
}

async function printTo(printer, payload) {
  const t = (printer && printer.transport) || 'ip';
  if (t === 'ip')   return withRetry(() => printIp(printer.target, payload, printer), 3);
  if (t === 'usb')  return printUsb(printer.target, payload);
  if (t === 'file') return printFile(printer.target, payload);
  throw new Error(`unknown transport "${t}"`);
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Private Network Access: an HTTPS site (e.g. https://fnb.akanhyd.com) calling
    // this loopback server triggers a PNA preflight in Chrome/Edge. Without this
    // header the browser blocks the call and the page shows "fetch failed".
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, platform: os.platform(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
  }

  // Live printer status for the dashboard: GET /printer-status?target=ip:9100
  if (req.method === 'GET' && url.pathname === '/printer-status') {
    const target = url.searchParams.get('target');
    if (!target) return sendJson(res, 400, { ok: false, error: 'target required' });
    queryIpStatus(target).then((s) => sendJson(res, 200, { ok: true, target, ...s }))
      .catch((e) => sendJson(res, 200, { ok: false, target, reachable: false, error: String(e.message) }));
    return;
  }

  // Batch print — fan out a whole table's KOTs in PARALLEL (sub-second). Body:
  // { jobs: [{ jobId?, printer, doc }] } → { results: [{ jobId, ok, bytes?, error? }] }
  if (req.method === 'POST' && url.pathname === '/print-batch') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4_000_000) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      const results = [];
      // Render each ticket, then GROUP BY PRINTER so every printer prints all its
      // tickets on ONE connection — concatenated bytes (each ticket already ends
      // with a cut). This removes the per-ticket reconnect gap (e.g. the tandoor
      // ticket coming out 2s after the first). Different printers still run in
      // parallel, so a 3-station order prints in ~1× time, not 3×.
      const groups = new Map();
      for (const j of jobs) {
        const jobId = j.jobId || `job_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
        const printer = j.printer || {};
        try {
          const payload = render(j.doc || {}, printer.width);
          const key = `${printer.transport || 'ip'}:${printer.target || ''}`;
          if (!groups.has(key)) groups.set(key, { printer, items: [] });
          groups.get(key).items.push({ jobId, payload });
        } catch (e) {
          results.push({ jobId, ok: false, error: 'render: ' + (e.message || e) });
        }
      }
      await Promise.allSettled([...groups.values()].map(async (g) => {
        const buf = Buffer.concat(g.items.map((it) => it.payload));   // all tickets, one stream
        try {
          await printTo(g.printer, buf);
          for (const it of g.items) results.push({ jobId: it.jobId, ok: true, bytes: it.payload.length });
        } catch (e) {
          for (const it of g.items) results.push({ jobId: it.jobId, ok: false, error: String(e.message || e) });
        }
      }));
      const okCount = results.filter((r) => r.ok).length;
      console.log(`[bridge] batch: ${okCount}/${results.length} printed across ${groups.size} printer(s), 1 connection each`);
      return sendJson(res, 200, { ok: okCount === results.length, results });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/print') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
      const jobId = body.jobId || `job_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
      try {
        const payload = render(body.doc || {}, body.printer && body.printer.width);
        if (url.searchParams.get('dryRun')) return sendJson(res, 200, { ok: true, jobId, bytes: payload.length, dryRun: true });
        await printTo(body.printer || {}, payload);
        console.log(`[bridge] printed ${jobId} (${payload.length} bytes) → ${body.printer?.transport}:${body.printer?.target}`);
        return sendJson(res, 200, { ok: true, jobId, bytes: payload.length });
      } catch (e) {
        console.error(`[bridge] job ${jobId} failed:`, e.message);
        return sendJson(res, 502, { ok: false, jobId, error: e.message });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  F&B Controller print bridge v${VERSION}`);
  console.log(`  listening on http://${HOST}:${PORT}   (platform: ${os.platform()})`);
  console.log(`  CORS origin: ${ALLOW_ORIGIN}`);
  console.log(`  health: curl http://${HOST}:${PORT}/health\n`);
});
