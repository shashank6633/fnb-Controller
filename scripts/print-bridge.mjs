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

const VERSION = '1.0.0';
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
function buildKot(doc, cols, doCut) {
  const chunks = [];
  const push = (b) => chunks.push(Buffer.from(b));
  const line = (s = '') => chunks.push(Buffer.from(String(s) + '\n', 'ascii'));
  const rule = () => line('-'.repeat(cols));

  push(CMD.init);
  push(CMD.alignCenter); push(CMD.boldOn); push(CMD.dblOn);
  line((doc.station || 'KITCHEN').toUpperCase());
  push(CMD.dblOff);
  line('KOT' + (doc.kotNumber ? ` #${doc.kotNumber}` : '') + (doc.reprint ? ' (REPRINT)' : ''));
  push(CMD.boldOff); push(CMD.alignLeft);
  rule();
  line(twoCol(doc.table ? `Table ${doc.table}` : (doc.orderType || 'Order'), doc.orderRef ? `#${doc.orderRef}` : '', cols));
  line(twoCol(fmtTime(doc.time), doc.server ? `Server: ${doc.server}` : '', cols));
  if (doc.covers) line(`Covers: ${doc.covers}`);
  rule();
  for (const it of (doc.items || [])) {
    push(CMD.boldOn);
    line(`${it.qty ?? 1} x ${it.name || ''}`);
    push(CMD.boldOff);
    for (const m of (it.mods || it.modifiers || [])) line(`    + ${m}`);
    if (it.notes) line(`    - ${it.notes}`);
  }
  rule();
  const count = (doc.items || []).reduce((s, it) => s + (Number(it.qty) || 1), 0);
  line(`Items: ${count}    (no prices on a KOT)`);
  if (doc.note) { line(''); line(`** ${doc.note} **`); }
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
function printIp(target, payload) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = String(target).split(':');
    const port = Number(portStr) || 9100;
    const sock = net.createConnection({ host, port, timeout: 6000 }, () => {
      sock.write(payload, () => sock.end());
    });
    sock.on('error', (e) => reject(new Error(`printer ${host}:${port} — ${e.message}`)));
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`printer ${host}:${port} timed out`)); });
    sock.on('close', () => resolve());
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

async function printTo(printer, payload) {
  const t = (printer && printer.transport) || 'ip';
  if (t === 'ip')   return printIp(printer.target, payload);
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
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, platform: os.platform(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
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
