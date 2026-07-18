/**
 * TeleCMI webhook simulator for the Call-to-Table CRM.
 *
 * Real TeleCMI webhooks need a public URL (ngrok in dev), so this script POSTs
 * realistic TeleCMI-shaped payloads straight at the local webhook routes:
 *   POST <base>/api/telecmi/webhook/live/<token>   (live "notify" events)
 *   POST <base>/api/telecmi/webhook/cdr/<token>    (call report / CDR)
 *
 * Usage (dev server must be running):
 *   npm run simulate:call                                   # full: ring → 2s → answered CDR
 *   npm run simulate:call -- --kind=missed                  # missed-call CDR → recovery row
 *   npm run simulate:call -- --kind=ring --phone=+919876543210
 *   npm run simulate:call -- --kind=outbound-answered --phone=+919876543210
 *   npm run simulate:call -- --base=http://localhost:3000
 *
 * Kinds:
 *   ring              → one live inbound ring event (screen-pop should fire)
 *   answered          → one answered inbound CDR
 *   missed            → one missed ("noanswer") inbound CDR (creates a recovery)
 *   outbound-answered → one answered OUTBOUND CDR (callback-attempt path)
 *   full (default)    → live ring, wait 2s, answered CDR for the same call id
 *
 * Webhook token resolution mirrors src/lib/ct/settings.ts webhookToken():
 * env TELECMI_WEBHOOK_SECRET (≥12 chars) wins; else ct_settings.webhook_token
 * read from fnb-controller.db (opened READONLY — this script never writes).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

type Kind = 'ring' | 'answered' | 'missed' | 'outbound-answered' | 'full';
const KINDS: Kind[] = ['ring', 'answered', 'missed', 'outbound-answered', 'full'];

const OUTLET_DID = '04066001234'; // the restaurant's TeleCMI number (fake)

// ─── arg parsing (--key=value or --key value) ───────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = 'true';
      }
    }
  }
  return out;
}

function randomIndianMobile(): string {
  let n = String(6 + Math.floor(Math.random() * 4)); // 6-9
  for (let i = 0; i < 9; i++) n += String(Math.floor(Math.random() * 10));
  return `+91${n}`;
}

// ─── webhook token (env wins, matching the server; else DB, readonly) ───────

function findDbPath(): string | null {
  const candidates = [path.join(process.cwd(), 'fnb-controller.db')];
  try {
    // Works when tsx runs this file as CJS (no "type":"module" in package.json)
    if (typeof __dirname !== 'undefined') {
      candidates.push(path.resolve(__dirname, '..', 'fnb-controller.db'));
    }
  } catch { /* ESM context — cwd candidate is enough */ }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* unreadable path — try next */ }
  }
  return null;
}

function resolveToken(): string {
  const env = process.env.TELECMI_WEBHOOK_SECRET;
  if (env && env.length >= 12) {
    console.log('token: using env TELECMI_WEBHOOK_SECRET (server prefers env too)');
    return env;
  }
  const dbPath = findDbPath();
  if (dbPath) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare(`SELECT value FROM ct_settings WHERE key = 'webhook_token'`)
          .get() as { value?: string } | undefined;
        if (row?.value) {
          console.log(`token: read ct_settings.webhook_token from ${dbPath}`);
          return row.value;
        }
      } finally {
        db.close();
      }
    } catch (e) {
      console.error(`token: could not read ${dbPath}: ${(e as Error).message}`);
    }
  } else {
    console.error('token: fnb-controller.db not found (run from the project root)');
  }
  console.error(
    '\nNo webhook token available. Either:\n' +
    '  - set TELECMI_WEBHOOK_SECRET (>=12 chars) in env for both server and this script, or\n' +
    '  - open the CRM Settings page (/crm-calls/settings) once so the server mints and\n' +
    '    persists ct_settings.webhook_token, then re-run.'
  );
  process.exit(1);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function post(url: string, payload: Record<string, unknown>): Promise<boolean> {
  console.log(`\n→ POST ${url}`);
  console.log(`  payload: ${JSON.stringify(payload)}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = (await res.text()).slice(0, 500);
    console.log(`← ${res.status} ${res.statusText}: ${body}`);
    if (res.status === 403) {
      console.error(
        '  (403 = token mismatch — the server is using a different webhook token.\n' +
        '   If TELECMI_WEBHOOK_SECRET is set for the dev server, set the same value here.)'
      );
    }
    return res.ok;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`← FAILED: ${msg}`);
    console.error('  (Is the dev server running at the --base URL? Try --base=http://localhost:3000)');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── TeleCMI-ish payload builders ────────────────────────────────────────────

function livePayload(callId: string, phone: string, status: 'ring' | 'answered' | 'hangup') {
  return {
    id: callId,
    from: phone,
    to: OUTLET_DID,
    direction: 'inbound',
    status,                                   // TeleCMI notify uses "status" for the event
    time: Math.floor(Date.now() / 1000),      // epoch seconds
    group: 'reception',
  };
}

function cdrPayload(opts: {
  callId: string;
  phone: string;
  direction: 'inbound' | 'outbound';
  status: 'answered' | 'noanswer';
  durationSec: number;
}) {
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - opts.durationSec - 8; // ~8s of ringing before answer/abandon
  const answered = opts.status === 'answered';
  return {
    id: opts.callId,
    from: opts.direction === 'inbound' ? opts.phone : OUTLET_DID,
    to: opts.direction === 'inbound' ? OUTLET_DID : opts.phone,
    direction: opts.direction,
    status: opts.status,
    time: startSec,                            // epoch seconds — call start
    end_time: endSec,
    answeredsec: answered ? opts.durationSec : 0,
    agent_name: answered ? 'gre.akan' : '',
    group: 'reception',
    record_url: answered
      ? `https://rest.telecmi.com/v2/play?file=sim-${opts.callId}.mp3`
      : '',
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help !== undefined || args.h !== undefined) {
    console.log(
      'Usage: npm run simulate:call -- [--phone=+919876543210] ' +
      `[--kind=${KINDS.join('|')}] [--base=http://localhost:3001]`
    );
    return;
  }

  const kind = (args.kind || 'full') as Kind;
  if (!KINDS.includes(kind)) {
    console.error(`Unknown --kind "${args.kind}". Valid: ${KINDS.join(', ')}`);
    process.exit(1);
  }
  const phone = args.phone || randomIndianMobile();
  const base = (args.base || 'http://localhost:3001').replace(/\/+$/, '');
  const token = resolveToken();
  const liveUrl = `${base}/api/telecmi/webhook/live/${token}`;
  const cdrUrl = `${base}/api/telecmi/webhook/cdr/${token}`;
  const callId = `sim-${Date.now()}`;

  console.log(`\nSimulating kind=${kind} phone=${phone} call-id=${callId} base=${base}`);

  let ok = true;
  switch (kind) {
    case 'ring':
      ok = await post(liveUrl, livePayload(callId, phone, 'ring'));
      if (ok) console.log('\nExpect: screen-pop on /crm-calls pages + a ringing card on /crm-calls/live.');
      break;

    case 'answered':
      ok = await post(cdrUrl, cdrPayload({ callId, phone, direction: 'inbound', status: 'answered', durationSec: 45 }));
      if (ok) console.log('\nExpect: answered inbound call in the Call Log; any open recovery for this phone auto-resolves.');
      break;

    case 'missed':
      ok = await post(cdrUrl, cdrPayload({ callId, phone, direction: 'inbound', status: 'noanswer', durationSec: 0 }));
      if (ok) console.log('\nExpect: missed call in the Call Log + a pending row in the Recovery Queue with an SLA countdown.');
      break;

    case 'outbound-answered':
      ok = await post(cdrUrl, cdrPayload({ callId, phone, direction: 'outbound', status: 'answered', durationSec: 60 }));
      if (ok) console.log('\nExpect: outbound call logged; a matching open recovery for this phone moves to "attempting" with a callback attempt.');
      break;

    case 'full': {
      ok = await post(liveUrl, livePayload(callId, phone, 'ring'));
      console.log('\n… ringing for 2s (screen-pop window) …');
      await sleep(2000);
      const cdrOk = await post(cdrUrl, cdrPayload({ callId, phone, direction: 'inbound', status: 'answered', durationSec: 45 }));
      ok = ok && cdrOk;
      if (ok) console.log('\nExpect: pop fired on ring, then the same call finalized as answered by the CDR (no duplicate rows).');
      break;
    }
  }

  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error('simulate-call failed:', e);
  process.exit(1);
});
