#!/usr/bin/env node
/**
 * Standalone KOT print test — proves a LAN ESC/POS thermal printer works,
 * independent of the app. Sends a sample kitchen ticket over a raw TCP socket
 * to the printer's IP on port 9100 (the ESC/POS standard). No dependencies.
 *
 * Run:
 *   node scripts/print-kot-test.mjs <printer-ip> [--58] [--port=9100] [--no-cut]
 * Examples:
 *   node scripts/print-kot-test.mjs 192.168.1.50            # 80mm (default)
 *   node scripts/print-kot-test.mjs 192.168.1.50 --58       # 58mm paper
 *
 * If a slip prints, the printer + our ESC/POS path are proven, and Phase 2 just
 * formats real ticket data through the same code. If the ₹ symbol prints as
 * garbage, that's the known codepage gotcha — we fall back to "Rs" (this script
 * already uses "Rs" to stay safe).
 */
import net from 'node:net';

const args = process.argv.slice(2);
const ip = args.find((a) => !a.startsWith('--'));
if (!ip) {
  console.error('Usage: node scripts/print-kot-test.mjs <printer-ip> [--58] [--port=9100] [--no-cut]');
  process.exit(1);
}
const port = Number((args.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 9100;
const cols = args.includes('--58') ? 32 : 48;     // chars per line: 58mm≈32, 80mm≈48
const doCut = !args.includes('--no-cut');

// ── ESC/POS command bytes ──
const ESC = 0x1b, GS = 0x1d;
const cmd = {
  init:        [ESC, 0x40],
  alignLeft:   [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  boldOn:      [ESC, 0x45, 0x01],
  boldOff:     [ESC, 0x45, 0x00],
  dblOn:       [GS, 0x21, 0x11],   // double width + height
  dblOff:      [GS, 0x21, 0x00],
  feed3:       [ESC, 0x64, 0x03],
  cut:         [GS, 0x56, 0x00],   // full cut
};

const chunks = [];
const push = (bytes) => chunks.push(Buffer.from(bytes));
const text = (s) => chunks.push(Buffer.from(s + '\n', 'ascii'));
const rule = () => text('-'.repeat(cols));
const now = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date());

// ── Sample kitchen ticket ──
push(cmd.init);
push(cmd.alignCenter); push(cmd.boldOn); push(cmd.dblOn);
text('TANDOOR');
push(cmd.dblOff); push(cmd.boldOff);
text('KOT (TEST)');
push(cmd.alignLeft);
rule();
text(`Table 12          #A-1`);
text(`${now}      Server: Raj`);
rule();
push(cmd.boldOn);
text(`2 x Punjabi Paneer Tikka`);
push(cmd.boldOff);
text(`    - extra spicy`);
push(cmd.boldOn);
text(`1 x Angara Chicken Kebab`);
push(cmd.boldOff);
rule();
text(`Items: 3    (no prices on a KOT)`);
push(cmd.feed3);
if (doCut) push(cmd.cut);

const payload = Buffer.concat(chunks);

console.log(`Connecting to ${ip}:${port} … (${cols} cols, ${doCut ? 'with' : 'no'} cut)`);
const sock = net.createConnection({ host: ip, port, timeout: 5000 }, () => {
  sock.write(payload, () => {
    console.log(`Sent ${payload.length} bytes. Check the printer for a slip.`);
    sock.end();
  });
});
sock.on('timeout', () => { console.error('Timed out — is the IP right and the printer on the same network?'); sock.destroy(); process.exit(2); });
sock.on('error', (e) => { console.error('Connection failed:', e.message, '\nCheck: printer IP, port 9100 open, same LAN, printer powered on.'); process.exit(2); });
sock.on('close', () => process.exit(0));
