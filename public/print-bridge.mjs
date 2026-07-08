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
 *            | { "type": "tspl" | "raw", "payload": "<bytes>" }  // sent verbatim
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
import { fileURLToPath } from 'node:url';

// Directory this script lives in -- cache.json / kot-outbox.json / offline-pos.html
// all sit next to the script (works whether run from public/ or scripts/).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE  = path.join(SCRIPT_DIR, 'cache.json');
const OUTBOX_FILE = path.join(SCRIPT_DIR, 'kot-outbox.json');
const OFFLINE_HTML_FILE = path.join(SCRIPT_DIR, 'offline-pos.html');
const PRINTED_FILE = path.join(SCRIPT_DIR, 'printed-jobs.json');  // jobId → ts (idempotency)

const VERSION = '2.5.0';   // 2.5.0 = GET /printers lists installed printers; USB target can be a printer NAME (raw-spooled to the Win32 spooler, no sharing) as well as a \\host\share; /printer-status is USB-aware. 2.4.0 = raw passthrough: doc.type 'tspl'|'raw' sends doc.payload bytes verbatim (TSPL2 labels for the TSC TE210 label printer) — no ESC/POS wrapping. 2.3.2 = bill item Rate/Amt columns are plain numbers (Rs only on the totals). 2.3.1 = bill item columns realigned. 2.3.0 = idempotent by jobId. 2.2.1 = offline LAN KOT + audit hardening.
const startedAt = Date.now();

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const PORT = Number(argVal('port', process.env.BRIDGE_PORT || 9920));
// Bind on ALL interfaces by default so captain tablets on the venue WiFi can
// reach http://<counter-ip>:9920/offline during an internet outage. An explicit
// --host=... flag or BRIDGE_HOST env still wins (e.g. lock back to 127.0.0.1).
const HOST = argVal('host', process.env.BRIDGE_HOST || '0.0.0.0');
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
// Double-HEIGHT only (normal width). Used for money rows so a long label +
// big amount keeps the FULL column width and can never run off the paper,
// while still printing tall/prominent.
function sizeCmdH(m) {
  const k = Math.max(1, Math.min(4, Math.round(m))) - 1;
  return [GS, 0x21, k & 0x0f];
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
// Plain number for the item table's Rate/Amt columns — NO "Rs" prefix (that only
// belongs on the totals: Sub Total / CGST / SGST / Discount / Service Charges /
// Total / Grand Total / Payment, which use money()). Keeps the columns narrow and
// well-spaced; ".00" only shown when there are actual paise.
function itemMoney(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v)
    ? v.toLocaleString('en-IN')
    : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Item row: name on the left, then Qty / Rate / Amt right-aligned in the GIVEN
// column widths `w` (computed once per table from the widest value incl. the
// header, so the Rate/Amt labels sit exactly above their numbers) with a
// guaranteed 1-space gap between every column — so an "Rs" value can never touch
// the qty. Name is truncated to fit. ASCII only.
function billItemRow(name, qty, rate, amt, cols, w) {
  const rj = (s, width) => { s = String(s); return s.length >= width ? s : ' '.repeat(width - s.length) + s; };
  const right = rj(qty, w.qty) + ' ' + rj(rate, w.rate) + ' ' + rj(amt, w.amt);
  let nm = String(name ?? '');
  const nameW = cols - right.length - 1;                 // ≥1 space between name and qty
  if (nameW < 1) return right.slice(-cols);
  if (nm.length > nameW) nm = nm.slice(0, Math.max(0, nameW - 1)) + '.';
  return nm + ' '.repeat(Math.max(1, cols - nm.length - right.length)) + right;
}

// Default BILL line order (mirrors DEFAULT_BILL_LINES in print.ts) — used when a
// doc carries no `lines` (backward compat / non-designed bills).
const DEFAULT_BILL_LINES = [
  { key: 'brand', enabled: true, size: 'xlarge' }, { key: 'company', enabled: true, size: 'normal' },
  { key: 'address', enabled: true, size: 'normal' }, { key: 'contact', enabled: true, size: 'normal' },
  { key: 'email', enabled: true, size: 'normal' }, { key: 'fssai', enabled: true, size: 'normal' },
  { key: 'gstin', enabled: true, size: 'normal' }, { key: 'orderType', enabled: true, size: 'large' },
  { key: 'floorTable', enabled: true, size: 'normal' }, { key: 'guestName', enabled: true, size: 'normal' },
  { key: 'mobile', enabled: true, size: 'normal' }, { key: 'dateTime', enabled: true, size: 'normal' },
  { key: 'captain', enabled: true, size: 'normal' }, { key: 'guestsOrder', enabled: true, size: 'normal' },
  { key: 'items', enabled: true, size: 'normal' }, { key: 'subTotal', enabled: true, size: 'normal' },
  { key: 'serviceCharge', enabled: true, size: 'normal' }, { key: 'cgst', enabled: true, size: 'normal' },
  { key: 'sgst', enabled: true, size: 'normal' }, { key: 'discount', enabled: true, size: 'normal' },
  { key: 'total', enabled: true, size: 'large' }, { key: 'grandTotal', enabled: true, size: 'large' },
  { key: 'payment', enabled: true, size: 'normal' }, { key: 'footer', enabled: false, size: 'normal' },
  { key: 'printedBy', enabled: true, size: 'normal' }, { key: 'printedOn', enabled: true, size: 'normal' },
];

function buildBill(doc, cols, doCut) {
  const chunks = [];
  const push = (b) => chunks.push(Buffer.from(b));
  const line = (s = '') => chunks.push(Buffer.from(String(s) + '\n', 'ascii'));
  const rule = () => line('-'.repeat(cols));
  const centerS = (s, m, bold = false) => {
    push(CMD.alignCenter); if (bold) push(CMD.boldOn);
    if (m > 1) push(sizeCmd(m)); line(s); if (m > 1) push(sizeCmd(1));
    if (bold) push(CMD.boldOff); push(CMD.alignLeft);
  };
  const leftS = (s, m, bold = false) => {
    if (bold) push(CMD.boldOn);
    if (m > 1) push(sizeCmd(m)); line(s); if (m > 1) push(sizeCmd(1));
    if (bold) push(CMD.boldOff);
  };
  // Money two-column row. Enlarged rows use double-HEIGHT only (not width) so
  // "Grand Total" + a big amount always keeps the full column width and never
  // runs off the 80mm paper — it just prints taller.
  const twoColS = (l, r, m, bold = false) => {
    if (bold) push(CMD.boldOn);
    if (m > 1) push(sizeCmdH(m));
    line(twoCol(l, r, cols));
    if (m > 1) push(sizeCmd(1));
    if (bold) push(CMD.boldOff);
  };

  push(CMD.init);
  const floor = doc.floor ? String(doc.floor) : '';
  const table = doc.table ? String(doc.table) : '';

  // One renderer per bill line key; conditional lines no-op when absent.
  const SECTIONS = {
    brand:       (m) => centerS(String(doc.brandName || 'RESTAURANT').toUpperCase(), m, true),
    company:     (m) => { if (doc.companyName) centerS(String(doc.companyName), m); },
    address:     (m) => { if (doc.address) centerS(String(doc.address), m); },
    contact:     (m) => { if (doc.contact) centerS(`Contact no: ${doc.contact}`, m); },
    email:       (m) => { if (doc.email) centerS(`Email: ${doc.email}`, m); },
    fssai:       (m) => { if (doc.fssai) centerS(`FSSAI no: ${doc.fssai}`, m); },
    gstin:       (m) => { if (doc.gstin) centerS(`GST no: ${doc.gstin}`, m); },
    orderType:   (m) => centerS(String(doc.orderType || 'DINE-IN').toUpperCase(), m, true),
    floorTable:  (m) => { if (floor || table) leftS(`${floor}${floor && table ? ' : ' : ''}${table}`, m); },
    guestName:   (m) => { if (doc.guestName) leftS(`Guest Name: ${doc.guestName}`, m); },
    mobile:      (m) => { if (doc.guestMobile) leftS(`Mobile: ${doc.guestMobile}`, m); },
    dateTime:    (m) => leftS(`Date & Time: ${fmtTime(doc.date)}`, m),
    captain:     (m) => { if (doc.captainName) leftS(`Captain Name: ${doc.captainName}`, m); },
    guestsOrder: (m) => leftS(twoCol(`Number of Guests: ${Number(doc.guests) || 0}`, doc.orderNo ? `Order no: ${doc.orderNo}` : '', cols), m),
    items:       (m) => {
      const its = (doc.items || []).map((it) => {
        const qty = Number(it.qty) || 1;
        const rate = Number(it.rate) || 0;
        const amount = it.amount != null ? Number(it.amount) : qty * rate;
        return { name: it.name || '', qty: String(qty), rate: itemMoney(rate), amt: itemMoney(amount) };
      });
      // One shared set of column widths for the whole table (widest value incl.
      // the header text) → header aligns over its numbers, columns keep a gap.
      const w = {
        qty:  Math.max(3, ...its.map((r) => r.qty.length)),
        rate: Math.max('Rate'.length, ...its.map((r) => r.rate.length)),
        amt:  Math.max('Amt'.length, ...its.map((r) => r.amt.length)),
      };
      push(CMD.boldOn); line(billItemRow('Item Name', 'Qty', 'Rate', 'Amt', cols, w)); push(CMD.boldOff);
      rule();
      for (const r of its) line(billItemRow(r.name, r.qty, r.rate, r.amt, cols, w));
    },
    subTotal:      (m) => twoColS('Sub Total', money(doc.subtotal ?? 0), m),
    serviceCharge: (m) => { if (Number(doc.serviceCharge)) twoColS('Service Charges', money(doc.serviceCharge), m); },
    cgst:          (m) => { if (Number(doc.cgst)) twoColS(`CGST@${doc.cgstPct != null ? doc.cgstPct : 2.5}%`, money(doc.cgst), m); },
    sgst:          (m) => { if (Number(doc.sgst)) twoColS(`SGST@${doc.sgstPct != null ? doc.sgstPct : 2.5}%`, money(doc.sgst), m); },
    discount:      (m) => { if (Number(doc.discount) > 0) twoColS('Discount', '-' + money(doc.discount), m); },
    total:         (m) => twoColS('TOTAL', money(doc.total ?? 0), Math.max(2, m), true),
    grandTotal:    (m) => { if (doc.grandTotal != null) twoColS('Grand Total', money(doc.grandTotal), m, true); },
    payment:       (m) => { if (doc.paymentMethod) { twoColS(`Paid by ${String(doc.paymentMethod).toUpperCase()}`, money(doc.amountPaid != null ? doc.amountPaid : (doc.grandTotal != null ? doc.grandTotal : doc.total)), m); twoColS('Balance', money(doc.balance != null ? doc.balance : 0), m); } },
    footer:        (m) => { if (doc.footer) { line(''); centerS(String(doc.footer), m); } },
    printedBy:     (m) => { if (doc.printedBy) leftS(`Printed by ${doc.printedBy}`, m); },
    printedOn:     (m) => leftS(`Printed on: ${fmtTime(doc.date)}`, m),
  };

  // Structural separators travel with their section (reorder-safe). These keys
  // always render, so their leading rule is never orphaned.
  const RULE_BEFORE = new Set(['orderType', 'guestsOrder', 'items', 'subTotal']);
  const order = Array.isArray(doc.lines) && doc.lines.length ? doc.lines : DEFAULT_BILL_LINES;
  let started = false;
  for (const ln of order) {
    const key = (ln && ln.key) || ln;
    if (ln && ln.enabled === false) continue;
    const fn = SECTIONS[key];
    if (!fn) continue;
    if (started && RULE_BEFORE.has(key)) rule();
    fn(mult((ln && ln.size) || 'normal'));
    started = true;
  }
  rule();

  push(CMD.feed3);
  if (doCut) push(CMD.cut);
  return Buffer.concat(chunks);
}

function render(doc, width) {
  // Raw passthrough for a NON-ESC/POS printer. The TSC TE210 is a direct-thermal
  // LABEL printer that speaks TSPL2 (its own command language), so the app sends a
  // ready-made TSPL2 command string as doc.payload with doc.type 'tspl' (or the
  // generic 'raw'). We emit those bytes VERBATIM — no init/cut/ESC-POS wrapping —
  // straight to the same USB/IP transports the KOT/bill path uses. `width` is
  // irrelevant for raw jobs (the label geometry is baked into the TSPL itself).
  if (doc.type === 'tspl' || doc.type === 'raw') {
    const p = doc.payload != null ? doc.payload : '';
    return Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8');
  }
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
    const sock = net.createConnection({ host, port, timeout: opts.connectTimeout || 6000 });
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

// Spawn a command, resolve on exit 0, reject with stderr otherwise.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    if (p.stderr) p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code} ${err.trim()}`))));
    p.on('error', (e) => reject(e));
  });
}

// Spawn a command and capture stdout.
function runCmdCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code} ${err.trim()}`))));
    p.on('error', (e) => reject(e));
  });
}

// PowerShell that raw-spools a file to a Windows printer BY NAME through the Win32
// print spooler (RAW datatype) — no sharing, no GDI driver mangling. Single-quoted
// here-string so PowerShell does not interpolate the C#. Written to a temp .ps1.
const RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$Printer,[Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FnbRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed for printer, err=" + Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "FNB Label"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed err=" + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed err=" + Marshal.GetLastWin32Error());
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try { Marshal.Copy(bytes, 0, p, bytes.Length); int w; if (!WritePrinter(h, p, bytes.Length, out w)) throw new Exception("WritePrinter failed err=" + Marshal.GetLastWin32Error()); if (w != bytes.Length) throw new Exception("WritePrinter partial write " + w + "/" + bytes.Length); }
        finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[FnbRawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($FilePath))`;

async function printUsb(target, payload) {
  // Cross-platform raw spool to an OS-installed USB printer. No native deps.
  const plat = os.platform();
  const t = String(target || '').trim();
  if (plat === 'win32') {
    const tmp = path.join(os.tmpdir(), `fnb-label-${Date.now()}-${process.hrtime()[1]}.bin`);
    await fs.promises.writeFile(tmp, payload);
    try {
      if (t.startsWith('\\\\')) {
        // \\host\share UNC path → copy /b (legacy; needs the printer shared with a
        // "Generic / Text Only" driver so raw bytes pass through).
        await runCmd('cmd', ['/c', 'copy', '/b', tmp, t]);
      } else {
        // A printer NAME → raw-spool through the Win32 spooler (no sharing required,
        // no GDI driver mangling). This is what the app's printer picker sends.
        const ps1 = path.join(os.tmpdir(), `fnb-rawprint-${Date.now()}-${process.hrtime()[1]}.ps1`);
        await fs.promises.writeFile(ps1, RAW_PRINT_PS1);
        try {
          await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Printer', t, '-FilePath', tmp]);
        } finally { fs.promises.unlink(ps1).catch(() => {}); }
      }
    } finally { fs.promises.unlink(tmp).catch(() => {}); }
    return;
  }
  // macOS / Linux: target = CUPS printer name (lpstat -p). -o raw = pass bytes through.
  return new Promise((resolve, reject) => {
    const p = spawn('lp', ['-d', t, '-o', 'raw'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`lp -d ${t} failed (${code}) ${err.trim()}`))));
    p.on('error', (e) => reject(new Error(`lp not available — ${e.message}`)));
    p.stdin.write(payload);
    p.stdin.end();
  });
}

// List installed printers so the app can offer a picker (name + share + port).
async function listPrinters() {
  const plat = os.platform();
  if (plat === 'win32') {
    const out = await runCmdCapture('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Get-CimInstance Win32_Printer | Select-Object Name,ShareName,PortName,Default | ConvertTo-Json -Compress']);
    let arr = [];
    try { const j = JSON.parse(out.trim() || '[]'); arr = Array.isArray(j) ? j : [j]; } catch {}
    return arr.filter(Boolean).map((p) => ({ name: p.Name || '', shareName: p.ShareName || '', port: p.PortName || '', isDefault: !!p.Default }));
  }
  // macOS / Linux: CUPS destinations
  try {
    const out = await runCmdCapture('lpstat', ['-e']).catch(() => runCmdCapture('lpstat', ['-a']));
    return out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).map((name) => ({ name, shareName: '', port: '', isDefault: false }));
  } catch { return []; }
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

async function printTo(printer, payload, opts = {}) {
  const t = (printer && printer.transport) || 'ip';
  // opts.fast (offline /kot): 1 attempt, 3s connect timeout, so a dead printer
  // fails in ~3s instead of ~18s — the order is journaled regardless, and the
  // captain is warned. The online /print path keeps the resilient 3x/6s default.
  const attempts = opts.fast ? 1 : 3;
  const connectTimeout = opts.fast ? 3000 : undefined;
  if (t === 'ip')   return withRetry(() => printIp(printer.target, payload, { ...printer, connectTimeout }), attempts);
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

// -- Offline LAN KOT: cache + outbox persistence (JSON files next to script) --
//
// cache.json      : the last CACHE the Print Agent pushed (menu/tables/printers/
//                   kotDesign). The offline mini-POS page and POST /kot both need
//                   it, so it must survive a bridge restart mid-outage.
// kot-outbox.json : { day:'YYYY-MM-DD', seq:n, jobs:[FIRE+localNumber...] }. The
//                   daily localNumber counter lives here (reset per Asia/Kolkata
//                   calendar day); jobs are the offline fires the counter Print
//                   Agent replays to the cloud when the internet returns.

let CACHE = null;                 // in-memory copy of the last CACHE
let OUTBOX = null;                // in-memory copy of the outbox document

// Today's date as YYYY-MM-DD in Asia/Kolkata (the calendar day the local KOT
// counter resets on). en-CA gives ISO-style YYYY-MM-DD directly.
function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function writeJsonFile(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj), 'utf8'); return true; }
  catch (e) { console.error(`[bridge] failed writing ${path.basename(file)}: ${e.message}`); return false; }
}

// ── Idempotency: never print the same jobId twice ────────────────────────────
// The browser outbox RETRIES any print it doesn't get a success-ack for. That's
// exactly what happens when the printer/LAN blips AFTER a ticket already printed
// — the ack is lost on the drop, so the outbox re-sends and (without this guard)
// the bridge reprints it: the "double print on disconnect/reconnect" the counter
// sees. Every real KOT/bill carries a STABLE jobId (kot_<id>, bill_<id>, and
// distinct ids for copies/reprints/master), so we remember printed jobIds for a
// few hours and treat a repeat as an instant success WITHOUT touching the printer.
// Legitimate reprints use a DIFFERENT id (…_r1) so they are never suppressed.
const PRINTED_TTL_MS = 6 * 3600_000;   // a jobId is unique per service day; 6h window
const PRINTED = new Map();             // jobId → printedAt (ms)

function loadPrinted() {
  const raw = readJsonFile(PRINTED_FILE);
  if (raw && typeof raw === 'object') {
    const now = Date.now();
    for (const [id, ts] of Object.entries(raw)) if (now - Number(ts) < PRINTED_TTL_MS) PRINTED.set(id, Number(ts));
  }
}
function alreadyPrinted(jobId) {
  if (!jobId) return false;
  const ts = PRINTED.get(jobId);
  if (ts == null) return false;
  if (Date.now() - ts >= PRINTED_TTL_MS) { PRINTED.delete(jobId); return false; }
  return true;
}
function markPrinted(jobId) {
  if (!jobId) return;
  PRINTED.set(jobId, Date.now());
  // prune expired ids, then persist so a bridge restart mid-service still dedups
  const now = Date.now();
  for (const [id, ts] of PRINTED) if (now - ts >= PRINTED_TTL_MS) PRINTED.delete(id);
  writeJsonFile(PRINTED_FILE, Object.fromEntries(PRINTED));
}
loadPrinted();

// Load CACHE from memory, falling back to cache.json on cold start.
function loadCache() {
  if (CACHE) return CACHE;
  CACHE = readJsonFile(CACHE_FILE);
  return CACHE;
}

// Load the outbox document; create a fresh one if missing/corrupt. Rolls the
// daily counter over when the stored day is not today (IST).
function loadOutbox() {
  if (!OUTBOX) OUTBOX = readJsonFile(OUTBOX_FILE);
  const day = todayIST();
  if (!OUTBOX || typeof OUTBOX !== 'object' || !Array.isArray(OUTBOX.jobs)) {
    OUTBOX = { day, seq: 0, jobs: [] };
  }
  if (OUTBOX.day !== day) { OUTBOX.day = day; OUTBOX.seq = 0; }   // new calendar day -> reset seq
  return OUTBOX;
}

// Assign the next local KOT number "L" + zero-padded 3-digit daily counter,
// persisting the bumped seq immediately so a restart never reuses a number.
function nextLocalNumber() {
  const box = loadOutbox();
  box.seq += 1;
  const n = String(box.seq).padStart(3, '0');
  return 'L' + n;
}

// Best-effort primary LAN IPv4 (for the startup log line only).
function primaryLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of (ifaces[name] || [])) {
      if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

// A tiny fallback page served by GET /offline when offline-pos.html is missing,
// so a captain who navigates here still sees a clear message (ASCII only).
const OFFLINE_FALLBACK_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Offline POS - not installed</title>' +
  '<style>body{font-family:system-ui,Arial,sans-serif;margin:2rem;line-height:1.5;color:#222}' +
  'code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style></head><body>' +
  '<h1>Offline POS page is missing</h1>' +
  '<p>The bridge is running, but <code>offline-pos.html</code> was not found next to ' +
  'the print bridge script. Ask the counter to open the Print Agent once while online ' +
  'so the offline page and menu cache are installed.</p>' +
  '<p>Bridge version ' + VERSION + '.</p></body></html>';

// Build the per-station KOT docs from one FIRE + the cached CACHE, exactly in the
// shape buildKot consumes. Groups FIRE.items by station; picks the printer per
// station (station-matched printer, else the default). Returns
// { docs:[{station,doc,printer}], missingPrinter:bool }.
function buildOfflineKotDocs(fire, cache, localNumber, nowIso) {
  const kotDesign = (cache && cache.kotDesign) || {};
  const lines = Array.isArray(kotDesign.lines) && kotDesign.lines.length ? kotDesign.lines : DEFAULT_KOT_LINES;
  const table = fire.table || {};
  const printers = Array.isArray(cache && cache.printers) ? cache.printers : [];
  const defaultPrinter = cache && cache.defaultPrinter ? cache.defaultPrinter : null;

  // Group items by station (blank/undefined station -> '' bucket, still prints).
  const byStation = new Map();
  for (const it of (fire.items || [])) {
    const st = it.station || '';
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st).push(it);
  }

  const docs = [];
  let missingPrinter = false;
  for (const [station, items] of byStation) {
    // LIQUOR band if ANY item in this station is not 'foods'; else FOOD.
    const anyLiquor = items.some((i) => i.item_type && i.item_type !== 'foods');
    const doc = {
      type: 'kot',
      station,
      lines,
      outletName: cache && cache.outletName ? cache.outletName : undefined,
      floor: table.zone || undefined,
      table: table.label || undefined,
      kotNumber: localNumber,
      foodLiquor: anyLiquor ? 'LIQUOR' : 'FOOD',
      captain: fire.captainName,
      orderType: 'DINE-IN',
      orderRef: localNumber,
      time: nowIso,                       // fmtTime() renders this in Asia/Kolkata
      headerNote: kotDesign.headerNote,
      footerNote: kotDesign.footerNote,
      items: items.map((i) => ({ qty: i.qty, name: i.name, notes: i.notes || undefined })),
    };
    const printer = printers.find((p) => p.station === station) || defaultPrinter;
    if (!printer) missingPrinter = true;
    docs.push({ station, doc, printer });
  }
  return { docs, missingPrinter };
}

// True when the request came from the counter PC itself (loopback). The bridge
// binds 0.0.0.0 so captain tablets can reach the offline page + POST /kot, but
// the endpoints that write files/redirect printers/poison the cache/mark orders
// synced must stay counter-only.
function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// Reachable from the LAN (captain tablets): the offline page, firing a KOT, the
// pending count, health — plus GET /cache (the offline page reads the menu).
// POST /cache, /print, /print-batch, /printer-status, /kot/mark-synced are
// counter-only (loopback) so a hostile LAN device can't write files, redirect
// printers, poison the cached menu, or mark orders synced.
const LAN_OPEN = new Set(['/health', '/offline', '/kot', '/kot/pending']);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  const lanOk = LAN_OPEN.has(url.pathname) || (req.method === 'GET' && url.pathname === '/cache');
  if (!lanOk && !isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: 'this endpoint is available only on the counter PC (localhost)' });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, platform: os.platform(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
  }

  // Installed printers (for the app's printer picker): GET /printers
  if (req.method === 'GET' && url.pathname === '/printers') {
    listPrinters().then((printers) => sendJson(res, 200, { ok: true, printers }))
      .catch((e) => sendJson(res, 200, { ok: false, printers: [], error: String(e.message) }));
    return;
  }

  // Live printer status: GET /printer-status?target=ip:9100 (IP) or a printer
  // NAME / \\host\share (USB). IP targets get a live ESC/POS status probe; USB
  // targets just confirm the printer is installed (a TCP probe is meaningless).
  if (req.method === 'GET' && url.pathname === '/printer-status') {
    const target = url.searchParams.get('target');
    if (!target) return sendJson(res, 400, { ok: false, error: 'target required' });
    const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(target) || (target.includes(':') && !target.startsWith('\\'));
    if (isIp) {
      queryIpStatus(target).then((s) => sendJson(res, 200, { ok: true, target, transport: 'ip', ...s }))
        .catch((e) => sendJson(res, 200, { ok: false, target, reachable: false, error: String(e.message) }));
    } else {
      listPrinters().then((printers) => {
        const norm = (s) => String(s || '').toLowerCase().replace(/^\\\\[^\\]+\\/, '');
        const key = norm(target);
        const found = printers.find((p) => norm(p.name) === key || (p.shareName && norm(p.shareName) === key));
        sendJson(res, 200, {
          ok: true, target, transport: 'usb', installed: !!found, reachable: !!found,
          supported: false, paperOut: false, paperLow: false, coverOpen: false, error: false,
        });
      }).catch((e) => sendJson(res, 200, { ok: false, target, reachable: false, error: String(e.message) }));
    }
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
        // Already printed (a retry after a lost ack) → instant success, no reprint.
        if (alreadyPrinted(jobId)) { results.push({ jobId, ok: true, deduped: true }); continue; }
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
          // Record BEFORE acking so a lost ack can't cause a reprint on retry.
          for (const it of g.items) { markPrinted(it.jobId); results.push({ jobId: it.jobId, ok: true, bytes: it.payload.length }); }
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
        // Already printed (a retry after a lost ack) → instant success, no reprint.
        if (alreadyPrinted(jobId)) { console.log(`[bridge] deduped ${jobId} (already printed)`); return sendJson(res, 200, { ok: true, jobId, deduped: true }); }
        await printTo(body.printer || {}, payload);
        markPrinted(jobId);
        console.log(`[bridge] printed ${jobId} (${payload.length} bytes) → ${body.printer?.transport}:${body.printer?.target}`);
        return sendJson(res, 200, { ok: true, jobId, bytes: payload.length });
      } catch (e) {
        console.error(`[bridge] job ${jobId} failed:`, e.message);
        return sendJson(res, 502, { ok: false, jobId, error: e.message });
      }
    });
    return;
  }

  // -- Offline LAN KOT endpoints ---------------------------------------------

  // POST /cache -- Print Agent pushes the latest CACHE (menu/tables/printers/
  // kotDesign). Store in memory AND write cache.json so it survives a restart.
  if (req.method === 'POST' && url.pathname === '/cache') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8_000_000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
      CACHE = body;
      writeJsonFile(CACHE_FILE, CACHE);
      const menuN = Array.isArray(body.menu) ? body.menu.length : 0;
      const tableN = Array.isArray(body.tables) ? body.tables.length : 0;
      console.log(`[bridge] cache updated: ${menuN} menu item(s), ${tableN} table(s), ${Array.isArray(body.printers) ? body.printers.length : 0} printer(s)`);
      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  // GET /cache -- return the last CACHE (memory, else cache.json), or {} if none.
  if (req.method === 'GET' && url.pathname === '/cache') {
    return sendJson(res, 200, loadCache() || {});
  }

  // GET /offline -- serve the self-contained offline mini-POS page from disk next
  // to the script. If it is missing, serve a tiny fallback that says so.
  if (req.method === 'GET' && url.pathname === '/offline') {
    let html;
    try { html = fs.readFileSync(OFFLINE_HTML_FILE, 'utf8'); }
    catch { html = OFFLINE_FALLBACK_HTML; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Private-Network': 'true',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  // POST /kot -- the offline page fires an order. Assign a local KOT number, group
  // by station, print each station's ticket via the SAME render+send path as
  // /print-batch, then journal the FIRE to the outbox for later cloud replay.
  if (req.method === 'POST' && url.pathname === '/kot') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4_000_000) req.destroy(); });
    req.on('end', async () => {
      let fire;
      try { fire = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
      const cache = loadCache();
      if (!cache || (!Array.isArray(cache.printers) && !cache.defaultPrinter)) {
        return sendJson(res, 400, { ok: false, error: 'no printer cached; open the Print Agent once while online' });
      }

      const nowIso = new Date().toISOString();
      const localNumber = nextLocalNumber();
      const { docs, missingPrinter } = buildOfflineKotDocs(fire, cache, localNumber, nowIso);
      if (missingPrinter && docs.some((d) => !d.printer)) {
        // At least one station had no station printer AND no default -> cannot print.
        return sendJson(res, 400, { ok: false, error: 'no printer cached; open the Print Agent once while online' });
      }

      // Render + group by printer exactly like /print-batch (one connection per
      // printer, all its station tickets concatenated), then send via printTo.
      const groups = new Map();
      const stationsPrinted = [];
      for (const d of docs) {
        const printer = d.printer || {};
        const payload = render(d.doc, printer.width);
        const key = `${printer.transport || 'ip'}:${printer.target || ''}`;
        if (!groups.has(key)) groups.set(key, { printer, items: [] });
        groups.get(key).items.push({ station: d.station, payload });
      }
      const stationsFailed = [];
      await Promise.allSettled([...groups.values()].map(async (g) => {
        const buf = Buffer.concat(g.items.map((it) => it.payload));
        try {
          await printTo(g.printer, buf, { fast: true });   // fail fast; order is journaled anyway
          for (const it of g.items) stationsPrinted.push(it.station);
        } catch (e) {
          for (const it of g.items) stationsFailed.push(it.station);
          console.error(`[bridge] offline KOT ${localNumber} print failed on ${g.printer.transport}:${g.printer.target} - ${e.message}`);
        }
      }));

      // Journal the fire regardless of print outcome -- the kitchen may still have
      // gotten the paper, and the cloud replay is what makes the order real. The
      // record carries localNumber + createdAt + syncedAt:null.
      const box = loadOutbox();
      const record = { ...fire, localNumber, createdAt: fire.createdAt || nowIso, syncedAt: null };
      box.jobs.push(record);
      writeJsonFile(OUTBOX_FILE, box);

      console.log(`[bridge] offline KOT ${localNumber}: ${stationsPrinted.length} printed${stationsFailed.length ? ', ' + stationsFailed.length + ' FAILED' : ''}`);
      // ok:true means the order was CAPTURED (journaled -> will sync). A failed
      // station is reported separately so the captain is warned WITHOUT re-firing
      // (a re-fire would mint a new clientRef and create a duplicate order).
      return sendJson(res, 200, { ok: true, localNumber, stationsPrinted, stationsFailed });
    });
    return;
  }

  // GET /kot/pending -- fires not yet replayed to the cloud (syncedAt == null).
  if (req.method === 'GET' && url.pathname === '/kot/pending') {
    const box = loadOutbox();
    const jobs = box.jobs.filter((j) => j.syncedAt == null);
    return sendJson(res, 200, { jobs });
  }

  // POST /kot/mark-synced -- the Print Agent confirms these clientRefs replayed;
  // stamp syncedAt so they stop appearing in /kot/pending.
  if (req.method === 'POST' && url.pathname === '/kot/mark-synced') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }); }
      const refs = new Set(Array.isArray(body.clientRefs) ? body.clientRefs : []);
      const now = new Date().toISOString();
      const box = loadOutbox();
      let marked = 0;
      for (const j of box.jobs) {
        if (j.syncedAt == null && refs.has(j.clientRef)) { j.syncedAt = now; marked += 1; }
      }
      if (marked) writeJsonFile(OUTBOX_FILE, box);
      return sendJson(res, 200, { ok: true, marked });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  const lanIp = primaryLanIp();
  console.log(`\n  F&B Controller print bridge v${VERSION}`);
  console.log(`  listening on http://${HOST}:${PORT}   (platform: ${os.platform()})`);
  console.log(`  CORS origin: ${ALLOW_ORIGIN}`);
  console.log(`  health: curl http://${HOST}:${PORT}/health`);
  // LAN offline URL a captain tablet navigates to during an internet outage.
  console.log(`  offline POS (share with captains): http://${lanIp}:${PORT}/offline\n`);
});
