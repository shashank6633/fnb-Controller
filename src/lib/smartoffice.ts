/**
 * HRMS — SmartOffice biometric connector (Phase 8, device FINALIZED).
 *
 * SERVER ONLY. Imports the db module and the attendance engine — never import
 * from 'use client' components. Contract: docs/HRMS_DECISIONS.md §8.1/§8.5.
 *
 * THE DEVICE: SmartOffice v1.0.1 ("Biometrics and HRMS Solution") — a web app
 * + database that runs ON THE VENUE LAN; punches land in ITS database and we
 * integrate over its HTTP API (vendor PDF, v1.0.1, authoritative).
 *
 * TOPOLOGY — READ BEFORE DEBUGGING "Failed to fetch"/ECONNREFUSED:
 * SmartOffice lives on the venue LAN; the production app lives on AWS.
 * Server-side calls from here only work when the venue exposes SmartOffice to
 * the app (port-forward / VPN / public IP). That exposure is DATA — the
 * settings keys below — never hardcoded. The CSV import provider remains the
 * guaranteed offline path when the link is down. (Production: a WireGuard
 * tunnel, Lightsail 10.99.0.1 <-> venue PC 10.99.0.2 — "Could not reach" at
 * http://10.99.0.2:88 means that tunnel is down.)
 *
 * WHERE THE API KEY MAY GO (checkSmartOfficeBaseUrl + soLookup): every call
 * carries the stored APIKey in its query string, and since owner ruling #90 a
 * non-admin ("Full HR access") may set the address. So the address is
 * guarded: loopback, "this network", link-local (169.254/16 — the cloud
 * metadata service), cloud-metadata host names, multicast/reserved and the
 * IPv4-embedding IPv6 ranges are refused — when saved, AND at call time on the
 * address the connection is actually opened to (DNS answers are checked inside
 * the socket's own lookup, so a name cannot be re-pointed between check and
 * connect). Private LAN / VPN ranges (10/8, 172.16/12, 192.168/16, 100.64/10,
 * fc00::/7) stay allowed — that is how a venue LAN is reached. Redirects are
 * never followed, and a reply is never echoed raw: only the vendor's own JSON
 * message (clipped) or "HTTP <status>". Changing the address requires the key
 * to be re-entered (the route's save_config), so a stored key is only ever
 * sent to the address it was saved with.
 *
 * THE API SHAPE (every quirk here is from the vendor PDF):
 *  · every parameter rides the QUERY STRING (even on POST endpoints);
 *  · auth is APIKey in the query;
 *  · responses are often BARE JSON strings ("Device Added Successfully."),
 *    sometimes {status:false,message:"Invalid API Key."}, sometimes
 *    {status,message,records,result}. soFetch parses tolerantly: try JSON,
 *    treat a bare string as the message, treat status===false or a message
 *    matching /not correct|Invalid API Key|not exist/i as failure;
 *  · GetDeviceLogs timestamps are DEVICE-LOCAL IST WALL TIME — the engine
 *    stores UTC, so every LogDate goes through istToUtc() (−330 min);
 *  · PhotoUploadInBiometric accepts a JSON body (used here — a base64 image
 *    in a query string would blow URL limits); Base64String is RAW base64,
 *    no data: prefix.
 *
 * Settings keys (shared settings KV — benign scalars per §2.7; hr_ prefix is
 * owned by /api/hr/settings routing, and hr_smartoffice_api_key contains
 * 'api_key' so SECRET_KEY_RE auto-masks it on every admin surface):
 *  · hr_smartoffice_base_url   e.g. http://203.0.113.7:8080 (venue-exposed)
 *  · hr_smartoffice_api_key    the SmartOffice APIKey
 *  · hr_smartoffice_serials    comma-separated device serial numbers
 *  · hr_smartoffice_last_sync  cursor: 'YYYY-MM-DD' — the last IST day a
 *    successful sync covered (advanced only after a successful fetch, never
 *    moved backwards; the next sync starts FROM it, re-checking that day,
 *    because a sync that ran during the day only saw that day's punches so far)
 *  · hr_smartoffice_auto_sync  JSON status of the 30-minute AUTO-SYNC
 *    (runSmartOfficeAutoSync, driven by the boot-armed scheduler tick in
 *    src/lib/scheduler.ts): last attempt / last result / failure streak.
 *    Written ONLY by runSmartOfficeAutoSync; never contains the API key.
 *
 * All punches funnel through recordAttendanceEvent() — THE only punch write
 * path (hr-attendance.ts). This module never inserts into
 * hr_attendance_events directly.
 */

import type Database from 'better-sqlite3';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { recordAttendanceEvent, getHrPunchDebounceMin } from './hr-attendance';
import { logAuditEvent } from './db';
import { fmtISTIsoDate } from './format-date';

/* ------------------------------------------------------------------ *
 * Config (settings KV readers — never throw, '' defaults)
 * ------------------------------------------------------------------ */

export interface SmartOfficeConfig {
  /** Normalised: trimmed, trailing slashes stripped. '' = not configured. */
  baseUrl: string;
  apiKey: string;
  /** Parsed from hr_smartoffice_serials (comma-separated, trimmed, non-empty). */
  serials: string[];
  /** 'YYYY-MM-DD' of the last fully-synced IST day, '' when never synced. */
  lastSync: string;
}

/** One settings value or '' — a config read must never take a caller down. */
function readSetting(db: Database.Database, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return String(row?.value ?? '').trim();
  } catch {
    return '';
  }
}

/** SmartOffice connection config from the settings KV. Never throws. */
export function getSmartOfficeConfig(db: Database.Database): SmartOfficeConfig {
  return {
    baseUrl: readSetting(db, 'hr_smartoffice_base_url').replace(/\/+$/, ''),
    apiKey: readSetting(db, 'hr_smartoffice_api_key'),
    serials: readSetting(db, 'hr_smartoffice_serials')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    lastSync: readSetting(db, 'hr_smartoffice_last_sync'),
  };
}

/** True when both the base URL and API key are set — the minimum for any call. */
export function isSmartOfficeConfigured(db: Database.Database): boolean {
  const cfg = getSmartOfficeConfig(db);
  return cfg.baseUrl !== '' && cfg.apiKey !== '';
}

/* ------------------------------------------------------------------ *
 * Address guard — where the server may send the API key
 * ------------------------------------------------------------------ */

/**
 * Addresses SmartOffice can NEVER be at, so the server never calls them with
 * the API key (see "WHERE THE API KEY MAY GO" in the file header). WHY it
 * exists: since owner ruling #90 a non-admin with "Full HR access" may set the
 * base URL. Measured 2026-10-29 (escalation check, before this guard): a
 * holder re-pointed the address at a host of their choosing and the stored key
 * arrived there in the query string; a loopback page's body came back in the
 * Test message word for word. Private LAN/VPN ranges are deliberately NOT
 * listed — production reaches SmartOffice at http://10.99.0.2:88 over a
 * WireGuard tunnel, and a VPN (CGNAT 100.64/10 included) is exactly how a venue
 * LAN gets exposed.
 */
const SO_BLOCKED_NETS: { net: string; prefix: number; type: 'ipv4' | 'ipv6'; why: string }[] = [
  { net: '0.0.0.0', prefix: 8, type: 'ipv4', why: '"this network" address' },
  { net: '127.0.0.0', prefix: 8, type: 'ipv4', why: 'loopback — this server itself' },
  { net: '169.254.0.0', prefix: 16, type: 'ipv4', why: 'link-local — where the cloud metadata service lives' },
  { net: '100.100.100.200', prefix: 32, type: 'ipv4', why: 'cloud metadata service' },
  { net: '168.63.129.16', prefix: 32, type: 'ipv4', why: 'cloud platform service address' },
  { net: '224.0.0.0', prefix: 4, type: 'ipv4', why: 'multicast' },
  { net: '240.0.0.0', prefix: 4, type: 'ipv4', why: 'reserved / broadcast' },
  // ::/96 = unspecified (::), loopback (::1) and the deprecated IPv4-compatible
  // form (::a.b.c.d). IPv4-MAPPED addresses (::ffff:a.b.c.d) need no rule of
  // their own: BlockList matches them against the IPv4 rules above.
  { net: '::', prefix: 96, type: 'ipv6', why: 'unspecified / loopback' },
  { net: 'fe80::', prefix: 10, type: 'ipv6', why: 'link-local' },
  { net: 'fd00:ec2::254', prefix: 128, type: 'ipv6', why: 'cloud metadata service' },
  { net: 'ff00::', prefix: 8, type: 'ipv6', why: 'multicast' },
  // Ranges that carry an IPv4 address inside an IPv6 one (NAT64, 6to4) could
  // smuggle 127.x / 169.254.x past the IPv4 rules; a venue never needs them —
  // enter the IPv4 address itself.
  { net: '64:ff9b::', prefix: 96, type: 'ipv6', why: 'NAT64 (an IPv4 address in IPv6 form — enter the IPv4 address)' },
  { net: '64:ff9b:1::', prefix: 48, type: 'ipv6', why: 'NAT64 (an IPv4 address in IPv6 form — enter the IPv4 address)' },
  { net: '2002::', prefix: 16, type: 'ipv6', why: '6to4 (an IPv4 address in IPv6 form — enter the IPv4 address)' },
];
const SO_BLOCKED_LISTS = SO_BLOCKED_NETS.map((r) => {
  const list = new net.BlockList();
  list.addSubnet(r.net, r.prefix, r.type);
  return { list, why: r.why };
});

/** Host NAMES that are always this machine or a cloud metadata service. */
const SO_BLOCKED_HOST_RE =
  /^(?:localhost|.+\.localhost|metadata|metadata\.google\.internal|metadata\.goog|instance-data|instance-data\.ec2\.internal)$/;

/** Why an IP may not be called, or null when it may. Non-IPs return null. */
function soBlockedIpReason(ip: string): string | null {
  const fam = net.isIP(ip);
  if (!fam) return null;
  const type = fam === 4 ? 'ipv4' : 'ipv6';
  for (const r of SO_BLOCKED_LISTS) {
    if (r.list.check(ip, type)) return r.why;
  }
  return null;
}

/**
 * Validate + normalise a SmartOffice base URL. '' is allowed (= clear the
 * connector). Otherwise: http(s) only; no "?" / "#" (the base is a prefix the
 * endpoint path is appended to — a "#" would let the address choose the exact
 * path); no user:password; and the host must not be a blocked name or address
 * (SO_BLOCKED_NETS). Returns the canonical form that is STORED and CALLED:
 * origin + path, without trailing slashes (so what is checked is what is used).
 * Pure apart from net.isIP/BlockList — no DNS here: a venue name that only
 * resolves once the tunnel/VPN is up must still be saveable. Names are checked
 * again, on the resolved address, at call time (soLookup).
 */
export function checkSmartOfficeBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const text = String(raw ?? '').trim().replace(/\/+$/, '');
  if (text === '') return { ok: true, url: '' };
  if (!/^https?:\/\//i.test(text)) {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }
  if (/[?#]/.test(text)) {
    return {
      ok: false,
      error:
        'Base URL must not contain "?" or "#" — enter only http(s)://address:port ' +
        '(plus a path, if SmartOffice sits under one)',
    };
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: 'Base URL is not a valid web address' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Base URL must not contain a user name or password' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host) return { ok: false, error: 'Base URL is not a valid web address' };
  if (SO_BLOCKED_HOST_RE.test(host)) {
    return {
      ok: false,
      error: `Base URL host "${host}" is not allowed — it is this server itself or a cloud metadata service, never the venue's SmartOffice`,
    };
  }
  const why = soBlockedIpReason(host);
  if (why) {
    return {
      ok: false,
      error: `Base URL address ${host} is not allowed (${why}) — enter the address SmartOffice is reachable at, e.g. its VPN/tunnel address`,
    };
  }
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * The comparable form of a base URL: canonical when valid, else the trimmed
 * text. save_config uses it to decide whether the ADDRESS changed (and so
 * whether the API key must be re-entered).
 */
export function smartOfficeBaseUrlKey(raw: string): string {
  const c = checkSmartOfficeBaseUrl(raw);
  return c.ok ? c.url : String(raw ?? '').trim().replace(/\/+$/, '');
}

type SoLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * The socket's own DNS lookup for SmartOffice calls. Resolves every address,
 * refuses the connection if ANY of them is blocked, and otherwise hands the
 * same answer to the socket — so the address checked IS the address
 * connected to (no re-resolution in between; a short-TTL name cannot swap in
 * 127.0.0.1 after the check). Honours the caller's `all` (Node's
 * happy-eyeballs connect asks for every address).
 */
function soLookup(hostname: string, options: dns.LookupOptions, callback: SoLookupCallback): void {
  const opts: dns.LookupOptions = options && typeof options === 'object' ? options : {};
  dns.lookup(
    hostname,
    { family: opts.family, hints: opts.hints, all: true },
    (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => {
      if (err) {
        callback(err, opts.all ? [] : '', undefined);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      for (const a of list) {
        const why = soBlockedIpReason(a.address);
        if (why) {
          const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to ${a.address} (${why})`);
          e.code = 'SO_BLOCKED_ADDRESS';
          callback(e, opts.all ? [] : '', undefined);
          return;
        }
      }
      if (list.length === 0) {
        const e: NodeJS.ErrnoException = new Error(`${hostname} did not resolve`);
        e.code = 'ENOTFOUND';
        callback(e, opts.all ? [] : '', undefined);
        return;
      }
      if (opts.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    },
  );
}

/* ------------------------------------------------------------------ *
 * soFetch — the one tolerant HTTP door to SmartOffice
 * ------------------------------------------------------------------ */

export interface SoResult<T = unknown> {
  ok: boolean;
  /** Human-readable outcome — the vendor's message when it sent one. */
  message: string;
  /** The parsed response body (array / object / string), when parseable. */
  data?: T;
}

/** Vendor failure phrasings observed in the v1.0.1 PDF's sample responses. */
const SO_FAILURE_RE = /not correct|Invalid API Key|not exist/i;

const SO_TIMEOUT_MS = 15_000;
/** A 31-day GetDeviceLogs chunk for a whole venue is a few MB; anything past
 *  this is not SmartOffice talking. */
const SO_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** The longest vendor message passed on (one line). */
const SO_MESSAGE_MAX = 300;

/** One line, at most SO_MESSAGE_MAX characters. */
function soClip(s: string): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > SO_MESSAGE_MAX ? `${one.slice(0, SO_MESSAGE_MAX - 1)}…` : one;
}

/**
 * Pull the human message out of the vendor's JSON shapes: a bare JSON string,
 * {message}, or ASP.NET's {Message, ExceptionMessage} error body. Clipped to
 * one line. ONLY JSON is ever read here — see soFetch on non-JSON replies.
 */
function soMessageOf(parsed: unknown): string {
  if (typeof parsed === 'string') return soClip(parsed);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const msg =
      typeof o.message === 'string' ? o.message : typeof o.Message === 'string' ? o.Message : '';
    const exc = typeof o.ExceptionMessage === 'string' ? o.ExceptionMessage : '';
    return soClip(exc && exc !== msg ? (msg ? `${msg} (${exc})` : exc) : msg);
  }
  return '';
}

/** A transport failure, classified for the message soFetch returns. */
type SoTransportCode = 'timeout' | 'blocked' | 'too_large' | 'read' | 'connect';
function soTransportError(code: SoTransportCode, message: string): Error & { soCode: SoTransportCode } {
  return Object.assign(new Error(message), { soCode: code });
}

/** Undo a Content-Encoding the server applied anyway (fetch used to). */
function soDecode(buf: Buffer, encoding: string | undefined): Buffer {
  const enc = String(encoding ?? '').trim().toLowerCase();
  const lim = { maxOutputLength: SO_MAX_RESPONSE_BYTES };
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, lim);
  if (enc === 'deflate') return zlib.inflateSync(buf, lim);
  if (enc === 'br') return zlib.brotliDecompressSync(buf, lim);
  return buf;
}

/**
 * One HTTP exchange through node:http(s) with soLookup pinned on the socket.
 * Never follows a redirect (a 3xx is just a status). Rejects with a
 * SoTransportCode-tagged error; resolves with status + content-type + text
 * (UTF-8, BOM stripped — what fetch's res.text() returned).
 */
function soRequest(
  url: URL,
  method: 'GET' | 'POST',
  jsonBody: string | undefined,
): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: http.ClientRequest | undefined;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
      req?.destroy();
    };

    const headers: Record<string, string> = { Accept: '*/*' };
    if (method === 'POST') {
      headers['Content-Length'] = String(jsonBody !== undefined ? Buffer.byteLength(jsonBody) : 0);
      if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
    }

    try {
      const mod = url.protocol === 'https:' ? https : http;
      req = mod.request(url, { method, headers, agent: false, lookup: soLookup }, (res) => {
        gotResponse = true;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > SO_MAX_RESPONSE_BYTES) {
            fail(soTransportError('too_large', 'reply too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          try {
            const body = soDecode(Buffer.concat(chunks), res.headers['content-encoding'] as string | undefined);
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              text: body.toString('utf8').replace(/^﻿/, ''),
            });
          } catch {
            reject(soTransportError('read', 'unreadable reply'));
          }
        });
        res.on('error', () => fail(soTransportError('read', 'reply interrupted')));
        res.on('close', () => {
          if (!res.complete) fail(soTransportError('read', 'reply interrupted'));
        });
      });
      timer = setTimeout(() => fail(soTransportError('timeout', 'timed out')), SO_TIMEOUT_MS);
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (e?.code === 'SO_BLOCKED_ADDRESS') fail(soTransportError('blocked', e.message));
        else fail(soTransportError(gotResponse ? 'read' : 'connect', e?.message || 'connection failed'));
      });
      if (jsonBody !== undefined) req.write(jsonBody);
      req.end();
    } catch (e) {
      fail(soTransportError('connect', e instanceof Error ? e.message : 'connection failed'));
    }
  });
}

/**
 * Call one SmartOffice endpoint. Builds the query string (URLSearchParams —
 * every param rides the query, even on POST), 15s timeout over the whole
 * exchange, parses tolerantly per the header notes. NEVER throws on HTTP,
 * network or parse problems — a refused connection comes back as ok:false
 * with a message naming the base URL, because the usual cause is topology
 * (SmartOffice is on the venue LAN and the AWS app can only reach it through
 * the venue's port-forward / VPN / public IP; see the file header).
 *
 * GUARDED (file header, "WHERE THE API KEY MAY GO"): the stored base URL is
 * re-checked with checkSmartOfficeBaseUrl on every call (a value written
 * before the guard existed, or behind the route's back, is refused too); the
 * socket resolves names through soLookup; redirects are not followed.
 *
 * WHAT COMES BACK AS `message` — never the raw reply:
 *   · a JSON reply → the vendor's own message (bare JSON string, message /
 *     Message, ASP.NET's ExceptionMessage), one line, ≤300 chars; 'OK' when a
 *     2xx carries none; an empty 2xx body is 'OK' as before;
 *   · a non-JSON reply → NOT shown. Non-2xx: "returned HTTP <status>"; 2xx:
 *     a failure saying the address answered but not with JSON (SmartOffice's
 *     Web API always answers JSON — an HTML/text page means the base URL does
 *     not point at it).
 */
export async function soFetch(
  cfg: SmartOfficeConfig,
  path: string,
  params: Record<string, string>,
  opts: { method?: 'GET' | 'POST'; jsonBody?: Record<string, unknown> } = {},
): Promise<SoResult> {
  if (!cfg.baseUrl || !cfg.apiKey) {
    return { ok: false, message: 'SmartOffice is not configured (base URL / API key missing)' };
  }

  const guard = checkSmartOfficeBaseUrl(cfg.baseUrl);
  if (!guard.ok) {
    return {
      ok: false,
      message: `The saved SmartOffice base URL is refused: ${guard.error}. Save a valid address on HR → Biometric & Import (the API key must be re-entered with it).`,
    };
  }

  let url: URL;
  try {
    url = new URL(`${guard.url}/${path.replace(/^\/+/, '')}`);
  } catch {
    return { ok: false, message: 'The saved SmartOffice base URL is not a valid web address' };
  }
  url.search = new URLSearchParams({ APIKey: cfg.apiKey, ...params }).toString();

  let reply: { status: number; contentType: string; text: string };
  try {
    reply = await soRequest(
      url,
      opts.method ?? 'GET',
      opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : undefined,
    );
  } catch (e: unknown) {
    const code = (e as { soCode?: SoTransportCode })?.soCode;
    const detail = e instanceof Error ? e.message : '';
    if (code === 'timeout') {
      return {
        ok: false,
        message: `SmartOffice at ${cfg.baseUrl} did not answer within ${SO_TIMEOUT_MS / 1000}s — the device server may be unreachable from this app (it lives on the venue LAN; check the port-forward/VPN)`,
      };
    }
    if (code === 'blocked') {
      return {
        ok: false,
        message: `Refused to call SmartOffice at ${cfg.baseUrl}: ${detail} — this app never sends the API key to a loopback, link-local or cloud-metadata address`,
      };
    }
    if (code === 'too_large') {
      return {
        ok: false,
        message: `SmartOffice at ${cfg.baseUrl} sent a reply larger than ${SO_MAX_RESPONSE_BYTES / (1024 * 1024)} MB — try a shorter date range`,
      };
    }
    if (code === 'read') {
      return { ok: false, message: `SmartOffice at ${cfg.baseUrl} sent an unreadable response` };
    }
    return {
      ok: false,
      message: `Could not reach SmartOffice at ${cfg.baseUrl} — it runs on the venue LAN and must be exposed to this app (port-forward / VPN / public IP); the CSV import remains the offline path`,
    };
  }

  const status = reply.status;
  const isOk = status >= 200 && status < 300;
  const body = reply.text.trim();

  // Tolerant parse — JSON only. An empty body is the vendor saying nothing
  // (as before: a 2xx with no body is 'OK').
  let parsed: unknown = '';
  let isJson = true;
  if (body !== '') {
    try {
      parsed = JSON.parse(body);
    } catch {
      isJson = false;
    }
  }

  if (!isJson) {
    // Never echoed: whatever answered is not SmartOffice's JSON API, and its
    // page could be anything (see the guard notes in the file header).
    if (!isOk) {
      return { ok: false, message: `SmartOffice at ${cfg.baseUrl} returned HTTP ${status}` };
    }
    const ct = reply.contentType.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9.+/-]/g, '').slice(0, 60);
    return {
      ok: false,
      message: `The address ${cfg.baseUrl} answered HTTP ${status}${ct ? ` (${ct})` : ''} but not with JSON — it does not look like the SmartOffice API; check the base URL (the reply is not shown)`,
    };
  }

  const vendorMsg = soMessageOf(parsed);
  const message = vendorMsg || (isOk ? 'OK' : '');

  if (!isOk) {
    return {
      ok: false,
      message: message || `SmartOffice at ${cfg.baseUrl} returned HTTP ${status}`,
      data: parsed,
    };
  }
  const statusFalse =
    !!parsed && typeof parsed === 'object' && (parsed as { status?: unknown }).status === false;
  if (statusFalse || SO_FAILURE_RE.test(message)) {
    return { ok: false, message: vendorMsg || 'SmartOffice reported a failure', data: parsed };
  }
  return { ok: true, message, data: parsed };
}

/* ------------------------------------------------------------------ *
 * Typed endpoint wrappers (thin — soFetch owns all the tolerance)
 * ------------------------------------------------------------------ */

/** POST AddBiometric — register a device with the SmartOffice server. */
export function soAddDevice(
  cfg: SmartOfficeConfig,
  deviceName: string,
  serialNumber: string,
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/AddBiometric',
    { DeviceName: deviceName, SerialNumber: serialNumber },
    { method: 'POST' },
  );
}

/** GET DeleteBiometric — remove a device from the SmartOffice server. */
export function soDeleteDevice(cfg: SmartOfficeConfig, serialNumber: string): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/DeleteBiometric', { SerialNumber: serialNumber });
}

/** One punch as SmartOffice reports it, normalised for the sync pass. */
export interface SoPunchRow {
  /** The id the DEVICE knows — resolves via hr_biometric_map. */
  employeeCode: string;
  /** DEVICE-LOCAL IST wall time 'YYYY-MM-DD HH:MM:SS' — NOT UTC. */
  logDateIst: string;
  serialNumber: string;
  /** '' when the device did not report a direction (pairing alternates). */
  direction: '' | 'in' | 'out';
}

/**
 * GET GetDeviceLogs — every punch across all registered devices for the date
 * range (FromDate/ToDate 'YYYY-MM-DD', inclusive, device-local IST days).
 * Rows are normalised; anything without an EmployeeCode or LogDate is
 * dropped from `rows` (there is nothing to file it under).
 */
export async function soGetDeviceLogs(
  cfg: SmartOfficeConfig,
  from: string,
  to: string,
): Promise<SoResult & { rows: SoPunchRow[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/GetDeviceLogs', { FromDate: from, ToDate: to });
  const rows: SoPunchRow[] = [];
  if (res.ok && Array.isArray(res.data)) {
    for (const raw of res.data as Record<string, unknown>[]) {
      const employeeCode = String(raw?.EmployeeCode ?? '').trim();
      const logDateIst = String(raw?.LogDate ?? '').trim();
      if (!employeeCode || !logDateIst) continue;
      const dirRaw = String(raw?.PunchDirection ?? '').trim().toLowerCase();
      rows.push({
        employeeCode,
        logDateIst,
        serialNumber: String(raw?.SerialNumber ?? '').trim(),
        direction: dirRaw === 'in' ? 'in' : dirRaw === 'out' ? 'out' : '',
      });
    }
  }
  return { ...res, rows };
}

/** POST UploadUser — push one user to device(s). SerialNumbers is comma-joined. */
export function soUploadUser(
  cfg: SmartOfficeConfig,
  input: { employeeName: string; employeeCode: string; cardNumber?: string; serialNumbers: string[] },
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/UploadUser',
    {
      EmployeeName: input.employeeName,
      EmployeeCode: input.employeeCode,
      CardNumber: input.cardNumber ?? '',
      SerialNumbers: input.serialNumbers.join(','),
    },
    { method: 'POST' },
  );
}

/** POST DeleteUser — remove one user from device(s). */
export function soDeleteUser(
  cfg: SmartOfficeConfig,
  employeeCode: string,
  serialNumbers: string[],
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/DeleteUser',
    { EmployeeCode: employeeCode, SerialNumbers: serialNumbers.join(',') },
    { method: 'POST' },
  );
}

/** One enrolled user as a device reports it. */
export interface SoLiveUser {
  employeeCode: string;
  fpCount: number;
  privilege: string;
}

/** GET FetchLiveUsersFromBiometric — who is enrolled on ONE device right now. */
export async function soFetchLiveUsers(
  cfg: SmartOfficeConfig,
  serialNumber: string,
): Promise<SoResult & { users: SoLiveUser[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/FetchLiveUsersFromBiometric', {
    SerialNumber: serialNumber,
  });
  const users: SoLiveUser[] = [];
  if (res.ok && Array.isArray(res.data)) {
    for (const raw of res.data as Record<string, unknown>[]) {
      const employeeCode = String(raw?.EmployeeCode ?? '').trim();
      if (!employeeCode) continue;
      users.push({
        employeeCode,
        fpCount: Number(raw?.FPCount ?? 0) || 0,
        privilege: String(raw?.Privilege ?? '').trim(),
      });
    }
  }
  return { ...res, users };
}

/**
 * GET SetUserExpiration — expire a user's device access on a date
 * ('yyyy-MM-dd'). SerialNumber '0' targets ALL devices (vendor convention).
 */
export function soSetUserExpiration(
  cfg: SmartOfficeConfig,
  serialNumber: string,
  employeeCode: string,
  expirationDate: string,
): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/SetUserExpiration', {
    SerialNumber: serialNumber,
    EmployeeCode: employeeCode,
    ExpirationDate: expirationDate,
  });
}

/** One queued/executed device command as the server reports it. */
export interface SoDeviceCommand {
  title: string;
  deviceCode: string;
  serialNumber: string;
  creationDate: string;
  executionDate: string;
  status: string;
  response: string;
}

/** GET GetDeviceCommands — the command queue/history for a date range. */
export async function soGetDeviceCommands(
  cfg: SmartOfficeConfig,
  from: string,
  to: string,
): Promise<SoResult & { commands: SoDeviceCommand[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/GetDeviceCommands', {
    FromDate: from,
    ToDate: to,
  });
  const commands: SoDeviceCommand[] = [];
  const records =
    res.ok && res.data && typeof res.data === 'object'
      ? (res.data as { records?: unknown }).records
      : undefined;
  if (Array.isArray(records)) {
    for (const raw of records as Record<string, unknown>[]) {
      commands.push({
        title: String(raw?.Title ?? '').trim(),
        deviceCode: String(raw?.DeviceCode ?? '').trim(),
        serialNumber: String(raw?.SerialNumber ?? '').trim(),
        creationDate: String(raw?.CreationDate ?? '').trim(),
        executionDate: String(raw?.ExecutionDate ?? '').trim(),
        status: String(raw?.Status ?? '').trim(),
        response: String(raw?.Response ?? '').trim(),
      });
    }
  }
  return { ...res, commands };
}

/**
 * POST PhotoUploadInBiometric — push a face photo to a device. Sent as a JSON
 * body (the PDF allows body OR query; a base64 image in a query string would
 * blow URL limits). Base64String must be RAW base64 — a data: URI prefix
 * (e.g. from the ImageUpload component) is stripped here.
 */
export function soPhotoUpload(
  cfg: SmartOfficeConfig,
  input: { serialNumber: string; employeeName: string; employeeCode: string; base64: string },
): Promise<SoResult> {
  const base64 = input.base64.replace(/^data:[^,]*,/, '');
  return soFetch(
    cfg,
    'api/v2/WebAPI/PhotoUploadInBiometric',
    {},
    {
      method: 'POST',
      jsonBody: {
        APIKey: cfg.apiKey,
        SerialNumber: input.serialNumber,
        EmployeeName: input.employeeName,
        EmployeeCode: input.employeeCode,
        Base64String: base64,
      },
    },
  );
}

/**
 * GET BlockUserinBiometric — block or unblock a user on a device.
 *
 * *** DO NOT "FIX" THE 0/1 ENCODING. Vendor PDF v1.0.1, verbatim:
 * "BlockUser (int): 0 - to block the user, 1 - to unblock the user."
 * Yes, it is inverted from what you expect: 0 BLOCKS, 1 UNBLOCKS.
 * Flipping it would block every staff member you meant to unblock and
 * lock the whole venue out of the gate. ***
 */
export function soBlockUser(
  cfg: SmartOfficeConfig,
  employeeCode: string,
  serialNumber: string,
  block: boolean,
): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/BlockUserinBiometric', {
    EmployeeCode: employeeCode,
    SerialNumber: serialNumber,
    BlockUser: String(block ? 0 : 1), // 0 = block, 1 = unblock — per the doc quote above
  });
}

/* ------------------------------------------------------------------ *
 * IST → UTC
 * ------------------------------------------------------------------ */

/**
 * SmartOffice LogDate is DEVICE-LOCAL IST WALL TIME ('YYYY-MM-DD HH:MM[:SS]').
 * The attendance engine stores UTC ('YYYY-MM-DD HH:MM:SS', no Z — the
 * datetime('now') shape), so subtract 330 minutes. Throws on an unparseable
 * input — a punch that cannot be dated must not be filed under a guessed time
 * (the sync pass catches per row and reports it as refused).
 */
export function istToUtc(logDateIst: string): string {
  const s = String(logDateIst ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error('Invalid SmartOffice punch time');
  const ms =
    Date.UTC(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      m[6] ? parseInt(m[6], 10) : 0,
    ) -
    330 * 60_000; // IST = UTC + 5:30 ⇒ UTC = IST − 330 min
  if (!Number.isFinite(ms)) throw new Error('Invalid SmartOffice punch time');
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/* ------------------------------------------------------------------ *
 * Small pure date helpers (UTC storage shape / IST calendar days)
 * ------------------------------------------------------------------ */

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** epoch ms → the engine's UTC storage shape 'YYYY-MM-DD HH:MM:SS'. */
function utcStringOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD' plus n calendar days (n may be negative). Pure calendar math. */
function isoPlusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Already-on-file guard — shared by the SmartOffice sync and the CSV import
 * ------------------------------------------------------------------ */

/**
 * Makes re-feeding punches that are already stored a no-op (see "RE-RUNNING A
 * RANGE" on syncSmartOfficePunches for the measured failure this prevents).
 *
 * isOnFile(employeeId, atUtc) is true when hr_attendance_events already holds,
 * from BEFORE this batch, either
 *   · a row for that employee at the identical instant (any source, even one
 *     that was stored as an ignored duplicate), or
 *   · a LIVE row for that employee within the debounce window (|Δ| <
 *     hr_punch_debounce_min, the engine's own rule) — any source, so a CSV
 *     export whose times lack seconds and a GPS/manual punch both count.
 * Rows the caller inserted in this batch (noteInserted) are excluded, so a
 * genuine double-tap inside one batch still reaches the engine and is stored
 * as an ignored duplicate exactly as before.
 *
 * Callers stay inside their own db.transaction(); this only reads.
 * business_date is stamped by the engine at write time and is always within
 * ±1 day of the punch's UTC date (IST = UTC+5:30, minus up to a day for
 * hr_day_cutoff); ±2 also covers a window that straddles UTC midnight. It is
 * in the WHERE so the lookup rides idx_hr_att_ev_emp_day instead of scanning
 * an employee's whole history.
 */
export function createAlreadyOnFileGuard(db: Database.Database): {
  isOnFile: (employeeId: string, atUtc: string) => boolean;
  noteInserted: (eventId: string) => void;
} {
  const debounceSec = getHrPunchDebounceMin(db) * 60;
  const stmt = db.prepare(
    `SELECT id, at, ignored FROM hr_attendance_events
     WHERE employee_id = ?
       AND business_date BETWEEN ? AND ?
       AND at BETWEEN ? AND ?`,
  );
  const inserted = new Set<string>();
  return {
    isOnFile(employeeId: string, atUtc: string): boolean {
      const ms = Date.parse(`${String(atUtc).replace(' ', 'T')}Z`);
      if (!Number.isFinite(ms)) return false; // the engine refuses it, with its reason
      const spanMs = (debounceSec - 1) * 1000; // engine rule: |Δ| < debounce, whole seconds
      const day = String(atUtc).slice(0, 10);
      const near = stmt.all(
        employeeId,
        isoPlusDays(day, -2),
        isoPlusDays(day, 2),
        utcStringOfMs(ms - spanMs),
        utcStringOfMs(ms + spanMs),
      ) as { id: string; at: string; ignored: number }[];
      return near.some(
        (r) => !inserted.has(String(r.id)) && (r.at === atUtc || Number(r.ignored) === 0),
      );
    },
    noteInserted(eventId: string): void {
      inserted.add(String(eventId));
    },
  };
}

/* ------------------------------------------------------------------ *
 * syncSmartOfficePunches — pull a date range into the attendance engine
 * ------------------------------------------------------------------ */

export interface SmartOfficeSyncResult {
  /** False only when the FETCH failed (config/network/API key) — per-row
   *  refusals do not fail the sync. */
  ok: boolean;
  /** The fetch failure message when ok=false; '' on success. */
  message: string;
  /** Punch rows SmartOffice returned for the range. */
  fetched: number;
  /** Rows written as live events (recomputed into day summaries). */
  recorded: number;
  /** Rows ALREADY ON FILE before this sync started — the same employee
   *  already has that punch stored (an earlier sync, the CSV import, or a
   *  GPS/manual punch within the debounce window). Skipped: no row written,
   *  nothing recomputed. See "RE-RUNNING A RANGE" below. */
  already_recorded: number;
  /** Rows the engine debounced (inserted append-only with ignored=1). */
  ignored_duplicates: number;
  /** Rows the engine refused (suspended/exited employee, unparseable time). */
  refused: { code: string; reason: string }[];
  /** Device EmployeeCodes with no active hr_biometric_map row — reported,
   *  never silently dropped. */
  unmatched: { employeeCode: string; punches: number }[];
}

/**
 * Pull SmartOffice punches for [from, to] (inclusive 'YYYY-MM-DD' IST days)
 * and feed them through recordAttendanceEvent().
 *
 * Shape: ALL awaits happen first (the soGetDeviceLogs fetch), then ONE
 * SYNCHRONOUS db.transaction() wraps the whole batch — better-sqlite3 is
 * synchronous and an await inside the callback would silently break
 * atomicity (the house rule).
 *
 * Per row: resolve hr_biometric_map (is_active=1, biometric_employee_id =
 * EmployeeCode, device_id = SerialNumber or the '' any-device wildcard; an
 * exact device match wins over the wildcard) → already-on-file check (below)
 * → recordAttendanceEvent with source 'biometric'. The engine throws for
 * suspended/exited employees — caught PER ROW and counted as refused with the
 * reason; the batch is never aborted. Debounced duplicates come back as
 * ignored events and are counted. Unmatched EmployeeCodes are tallied with
 * their punch counts.
 *
 * RE-RUNNING A RANGE IS SAFE — BECAUSE OF THE ALREADY-ON-FILE CHECK, NOT THE
 * ENGINE'S DEBOUNCE. The engine debounces against the employee's LATEST
 * non-ignored punch only, so feeding it a day whose punches are already stored
 * records every punch except the last one AGAIN, as live events. MEASURED
 * 2026-10-29 on a DB copy with the code as it was: one employee, 4 punches,
 * the same day synced 3 times → 10 live rows instead of 4 and the in/out
 * directions scrambled. The auto-sync re-checks the cursor day every 30
 * minutes, so this would have duplicated a whole day's attendance ~48 times.
 * Each fetched row is therefore first checked against the rows that existed
 * BEFORE this batch: a stored punch of the same employee at the identical
 * instant (even one that was itself stored as an ignored duplicate), or a
 * live one within the debounce window (any source — an earlier sync, the CSV
 * import whose times may lack seconds, a GPS/manual punch). Such a row is
 * skipped and counted in already_recorded. Rows inserted by THIS batch are
 * excluded from the check, so a genuine double-tap inside one fetch still
 * reaches the engine and is stored as an ignored duplicate exactly as before.
 *
 * hr_smartoffice_last_sync is set to `to` ONLY when the fetch succeeded — a
 * network failure leaves the cursor where it was so the next run re-covers
 * the gap. It never moves backwards (a manual back-fill of an older range
 * leaves a later cursor alone) and never past today (IST): a future cursor
 * would make the next sync start after days it never saw.
 */
export async function syncSmartOfficePunches(
  db: Database.Database,
  range: { from: string; to: string },
): Promise<SmartOfficeSyncResult> {
  const empty = emptySyncResult();

  const from = String(range?.from ?? '').trim();
  const to = String(range?.to ?? '').trim();
  if (!ISO_DAY_RE.test(from) || !ISO_DAY_RE.test(to)) {
    return { ...empty, message: 'Sync range must be YYYY-MM-DD dates' };
  }

  const cfg = getSmartOfficeConfig(db);
  if (!cfg.baseUrl || !cfg.apiKey) {
    return { ...empty, message: 'SmartOffice is not configured (base URL / API key missing)' };
  }

  // ── ALL awaits happen here, before the transaction.
  const fetched = await soGetDeviceLogs(cfg, from, to);
  if (!fetched.ok) return { ...empty, message: fetched.message };

  // Chronological order is LOAD-BEARING: the engine's single-gate pairing
  // alternates IN/OUT by arrival order and debounces against the latest
  // punch — device logs are not guaranteed sorted, so sort by IST wall time
  // (string compare is chronological for 'YYYY-MM-DD HH:MM:SS').
  const rows = [...fetched.rows].sort((a, b) =>
    a.logDateIst < b.logDateIst ? -1 : a.logDateIst > b.logDateIst ? 1 : 0,
  );

  // Exact device mapping beats the '' any-device wildcard.
  const mapStmt = db.prepare(
    `SELECT employee_id FROM hr_biometric_map
     WHERE is_active = 1 AND biometric_employee_id = ?
       AND (device_id = ? OR device_id = '')
     ORDER BY (device_id != '') DESC
     LIMIT 1`,
  );

  // Already-on-file check (see the doc above and createAlreadyOnFileGuard).
  const onFile = createAlreadyOnFileGuard(db);

  // The cursor never passes today (IST) — see the doc above.
  const today = fmtISTIsoDate(new Date());
  const cursorValue = today && to > today ? today : to;

  const result: SmartOfficeSyncResult = {
    ...empty,
    ok: true,
    fetched: rows.length,
    refused: [],
    unmatched: [],
  };
  const unmatchedCounts = new Map<string, number>();

  // ── ONE synchronous transaction wraps the whole batch + the cursor bump.
  const run = db.transaction(() => {
    for (const row of rows) {
      const mapped = mapStmt.get(row.employeeCode, row.serialNumber) as
        | { employee_id: string }
        | undefined;
      if (!mapped) {
        unmatchedCounts.set(row.employeeCode, (unmatchedCounts.get(row.employeeCode) ?? 0) + 1);
        continue;
      }
      try {
        const atUtc = istToUtc(row.logDateIst);
        if (onFile.isOnFile(mapped.employee_id, atUtc)) {
          result.already_recorded++;
          continue;
        }
        const { event } = recordAttendanceEvent(db, {
          employee_id: mapped.employee_id,
          source: 'biometric',
          at: atUtc,
          event_type:
            row.direction === 'in'
              ? 'check_in'
              : row.direction === 'out'
                ? 'check_out'
                : undefined, // no direction from the device ⇒ engine alternation (§8.2.3)
          device_info: row.serialNumber,
          created_by: '', // machine source — actor emails are for humans
        });
        onFile.noteInserted(event.id);
        if (event.ignored) result.ignored_duplicates++;
        else result.recorded++;
      } catch (e: unknown) {
        // Engine refusals (suspended/exited, bad timestamp) are per-row
        // outcomes, never batch aborts.
        result.refused.push({
          code: row.employeeCode,
          reason: e instanceof Error ? e.message : 'Punch was refused',
        });
      }
    }

    // Cursor: the fetch succeeded (we are here), so [from, to] is covered.
    // Forward-only, and only over a well-formed stored day that is not in the
    // future (a malformed or future value is simply replaced).
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('hr_smartoffice_last_sync', ?)
       ON CONFLICT(key) DO UPDATE SET value = CASE
         WHEN settings.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
              AND settings.value > excluded.value
              AND settings.value <= ?
         THEN settings.value
         ELSE excluded.value
       END`,
    ).run(cursorValue, today || cursorValue);
  });
  run();

  result.unmatched = [...unmatchedCounts.entries()]
    .map(([employeeCode, punches]) => ({ employeeCode, punches }))
    .sort((a, b) => b.punches - a.punches);
  return result;
}

/* ------------------------------------------------------------------ *
 * AUTO-SYNC — every 30 minutes, driven by the boot-armed scheduler tick
 * ------------------------------------------------------------------ */

/**
 * The automatic pull (owner ruling #89(2)). DRIVER: the in-process scheduler
 * tick in src/lib/scheduler.ts, armed at boot from src/instrumentation.ts
 * register() — the same tick every other background job rides (c25844a). The
 * tick runs every 5 min in business hours and every 30 min off-hours; THIS
 * function decides whether a pull is owed, so on most ticks it is one
 * settings read.
 *
 *  1. Not configured (no base URL or no API key) → 'not_configured'. No
 *     writes, no logs — an install without SmartOffice never hears about it.
 *  2. CLAIM, atomically across pm2 workers: one BEGIN IMMEDIATE transaction
 *     reads SO_AUTO_SYNC_KEY and, unless the last attempt is under 29 minutes
 *     old, stamps last_attempt_at = now. A second tick (this process or
 *     another) inside that window gets 'not_due', so runs never overlap and
 *     happen about every 30 minutes. A crashed run cannot wedge it: the stamp
 *     simply ages out.
 *  3. Range: to = today (IST); from = the hr_smartoffice_last_sync cursor, or
 *     today−7 on the very first run — the same default the manual Sync button
 *     uses. Walked in chunks of at most 31 days (a long outage is caught up
 *     without one enormous device call); each chunk starts the day after the
 *     previous one, so no day is ever skipped.
 *  4. Each chunk goes through syncSmartOfficePunches — the cursor moves only
 *     on a successful fetch, and re-checking the cursor day is safe (see its
 *     already-on-file check).
 *  5. The result is merged into SO_AUTO_SYNC_KEY (last run, ok/failed, the
 *     failure message VERBATIM, counts, failing_since, consecutive_failures,
 *     last_success_at) — the Biometric page reads it via
 *     GET /api/hr/biometric/smartoffice.
 *  6. NEVER THROWS. No reportServerError, no admin notifications, no
 *     WhatsApp: an unreachable SmartOffice (the venue LAN is not exposed to the
 *     cloud server today) is an expected state, recorded truthfully on the
 *     page and NOT alarmed every 30 minutes. console output only on a
 *     transition (first run, ok→failed, failed→ok) or when punches were
 *     recorded. Audited as 'hr.biometric.sync' by 'system:auto-sync' only when
 *     punches were recorded, or when the refused count changed (refused
 *     punches are not stored, so the same ones are re-refused on every pass of
 *     the same day — auditing each pass would only repeat the same fact).
 */

export const SO_AUTO_SYNC_INTERVAL_MIN = 30;
export const SO_AUTO_SYNC_KEY = 'hr_smartoffice_auto_sync';
/** The audit actor for automatic runs (humans are emails). */
export const SO_AUTO_SYNC_ACTOR = 'system:auto-sync';

/** A claim younger than this blocks the next run (one minute of tick jitter). */
const SO_AUTO_SYNC_CLAIM_MS = (SO_AUTO_SYNC_INTERVAL_MIN - 1) * 60_000;
/** First-ever run (no cursor yet) looks back this many days — = the route default. */
const SO_AUTO_SYNC_FIRST_RUN_DAYS = 7;
/** Max IST days per device call. */
const SO_AUTO_SYNC_CHUNK_DAYS = 31;
/** Max chunks per run (~a year); a longer backlog continues on the next run. */
const SO_AUTO_SYNC_MAX_CHUNKS = 12;

export interface SoAutoSyncCounts {
  fetched: number;
  recorded: number;
  already_recorded: number;
  ignored_duplicates: number;
  /** Punches the engine refused (suspended/exited staff, bad time). */
  refused: number;
  /** DISTINCT device employee codes with no active mapping. */
  unmatched: number;
}

export interface SoAutoSyncStatus {
  /** ISO UTC instant of the last CLAIMED attempt; '' = never. */
  last_attempt_at: string;
  /** ISO UTC instant the last run FINISHED; '' = no run has finished yet. */
  last_run_at: string;
  /** Result of the last finished run; null = none yet. */
  last_ok: boolean | null;
  /** The failure reason VERBATIM when last_ok=false; '' on success. */
  last_message: string;
  /** The IST day range the last run covered ('YYYY-MM-DD'). */
  last_from: string;
  last_to: string;
  last_counts: SoAutoSyncCounts | null;
  /** ISO UTC instant of the last successful run; '' = never. */
  last_success_at: string;
  /** ISO UTC instant of the first failure in the current streak; '' when the
   *  last run succeeded. */
  failing_since: string;
  /** Failed runs in a row (0 after a success). */
  consecutive_failures: number;
}

/** The stored auto-sync status, normalised. Never throws ('' / null defaults). */
export function readSmartOfficeAutoSyncStatus(db: Database.Database): SoAutoSyncStatus {
  let j: Record<string, unknown> = {};
  try {
    const raw = readSetting(db, SO_AUTO_SYNC_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      j = parsed as Record<string, unknown>;
    }
  } catch {
    j = {};
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const c = j.last_counts;
  const counts: SoAutoSyncCounts | null =
    c && typeof c === 'object' && !Array.isArray(c)
      ? {
          fetched: num((c as Record<string, unknown>).fetched),
          recorded: num((c as Record<string, unknown>).recorded),
          already_recorded: num((c as Record<string, unknown>).already_recorded),
          ignored_duplicates: num((c as Record<string, unknown>).ignored_duplicates),
          refused: num((c as Record<string, unknown>).refused),
          unmatched: num((c as Record<string, unknown>).unmatched),
        }
      : null;
  return {
    last_attempt_at: str(j.last_attempt_at),
    last_run_at: str(j.last_run_at),
    last_ok: typeof j.last_ok === 'boolean' ? j.last_ok : null,
    last_message: str(j.last_message),
    last_from: str(j.last_from),
    last_to: str(j.last_to),
    last_counts: counts,
    last_success_at: str(j.last_success_at),
    failing_since: str(j.failing_since),
    consecutive_failures: num(j.consecutive_failures),
  };
}

function writeAutoSyncStatus(db: Database.Database, s: SoAutoSyncStatus): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SO_AUTO_SYNC_KEY, JSON.stringify(s));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One auto-sync pass (see the section doc above). `now` is injectable for
 * tests; production passes nothing. NEVER THROWS.
 */
export async function runSmartOfficeAutoSync(
  db: Database.Database,
  now: Date = new Date(),
): Promise<{ outcome: 'not_configured' | 'not_due' | 'ok' | 'failed'; detail: string }> {
  try {
    // (1) Not configured → silent no-op.
    if (!isSmartOfficeConfigured(db)) {
      return {
        outcome: 'not_configured',
        detail: 'SmartOffice base URL / API key are not saved — auto-sync is off',
      };
    }

    const nowMs = now.getTime();
    const attemptIso = now.toISOString();
    const startedRealMs = Date.now();

    // (2) Atomic claim (BEGIN IMMEDIATE — serialises pm2 workers).
    let prev: SoAutoSyncStatus | null;
    try {
      prev = db
        .transaction((): SoAutoSyncStatus | null => {
          const cur = readSmartOfficeAutoSyncStatus(db);
          const lastMs = Date.parse(cur.last_attempt_at);
          // |Δ|: a stamp from the future (the clock was moved back) blocks
          // only for the same window instead of until the clock catches up.
          if (Number.isFinite(lastMs) && Math.abs(nowMs - lastMs) < SO_AUTO_SYNC_CLAIM_MS) {
            return null;
          }
          writeAutoSyncStatus(db, { ...cur, last_attempt_at: attemptIso });
          return cur;
        })
        .immediate();
    } catch (e) {
      // Database busy past busy_timeout — nothing ran, nothing was written;
      // the next tick tries again.
      console.warn('[smartoffice] auto-sync could not claim a run:', errText(e));
      return { outcome: 'failed', detail: `Could not claim the run: ${errText(e)}` };
    }
    if (!prev) {
      return {
        outcome: 'not_due',
        detail: `Next automatic sync is due ${SO_AUTO_SYNC_INTERVAL_MIN} min after the last attempt`,
      };
    }

    // (3) Range: cursor (or today−7) → today, IST days.
    const cfg = getSmartOfficeConfig(db);
    const to = fmtISTIsoDate(now);
    let from = ISO_DAY_RE.test(cfg.lastSync)
      ? cfg.lastSync
      : isoPlusDays(to, -SO_AUTO_SYNC_FIRST_RUN_DAYS);
    if (from > to) from = to;

    // (4) Walk forward in chunks; stop at the first failure.
    const counts: SoAutoSyncCounts = {
      fetched: 0,
      recorded: 0,
      already_recorded: 0,
      ignored_duplicates: 0,
      refused: 0,
      unmatched: 0,
    };
    const unmatchedCodes = new Set<string>();
    let ok = true;
    let message = '';
    let coveredTo = '';
    let chunkFrom = from;
    for (let i = 0; i < SO_AUTO_SYNC_MAX_CHUNKS && chunkFrom <= to; i++) {
      const lastDay = isoPlusDays(chunkFrom, SO_AUTO_SYNC_CHUNK_DAYS - 1);
      const chunkTo = lastDay < to ? lastDay : to;
      let r: SmartOfficeSyncResult;
      try {
        r = await syncSmartOfficePunches(db, { from: chunkFrom, to: chunkTo });
      } catch (e) {
        // A database fault inside this app (not a SmartOffice reply) — the
        // batch transaction rolled back, the cursor did not move.
        r = { ...emptySyncResult(), message: `Sync failed inside this app: ${errText(e)}` };
      }
      if (!r.ok) {
        ok = false;
        message = r.message || 'SmartOffice sync failed';
        break;
      }
      counts.fetched += r.fetched;
      counts.recorded += r.recorded;
      counts.already_recorded += r.already_recorded;
      counts.ignored_duplicates += r.ignored_duplicates;
      counts.refused += r.refused.length;
      for (const u of r.unmatched) unmatchedCodes.add(u.employeeCode);
      coveredTo = chunkTo;
      if (chunkTo >= to) break;
      chunkFrom = isoPlusDays(chunkTo, 1);
    }
    counts.unmatched = unmatchedCodes.size;
    // A backlog longer than MAX_CHUNKS stops short of today: say so, truthfully.
    const partial = ok && coveredTo !== '' && coveredTo < to;

    // (5) Merge the result into the status.
    const finishedIso = new Date(nowMs + (Date.now() - startedRealMs)).toISOString();
    const next: SoAutoSyncStatus = {
      last_attempt_at: attemptIso,
      last_run_at: finishedIso,
      last_ok: ok,
      last_message: ok
        ? partial
          ? `Caught up to ${coveredTo}; the rest of the backlog continues on the next run`
          : ''
        : message,
      last_from: from,
      last_to: ok ? coveredTo || to : to,
      last_counts: counts,
      last_success_at: ok ? finishedIso : prev.last_success_at,
      failing_since: ok
        ? ''
        : prev.last_ok === false && prev.failing_since
          ? prev.failing_since
          : attemptIso,
      consecutive_failures: ok ? 0 : prev.consecutive_failures + 1,
    };
    writeAutoSyncStatus(db, next);

    // (6) Quiet logging: transitions and real work only.
    const countsLine =
      `fetched ${counts.fetched} · recorded ${counts.recorded} · already on file ${counts.already_recorded}` +
      ` · ignored dupes ${counts.ignored_duplicates} · refused ${counts.refused} · unmatched ids ${counts.unmatched}`;
    if (prev.last_ok === null || prev.last_ok !== ok || counts.recorded > 0) {
      if (ok) {
        console.log(
          `[smartoffice] auto-sync ${from}→${next.last_to}: ${countsLine}` +
            (prev.last_ok === false ? ' (recovered)' : ''),
        );
      } else {
        console.warn(`[smartoffice] auto-sync FAILED ${from}→${to}: ${message}`);
      }
    }
    const prevRefused = prev.last_counts?.refused ?? 0;
    if (
      counts.recorded > 0 ||
      (counts.refused > 0 && (counts.refused !== prevRefused || next.last_to !== prev.last_to))
    ) {
      logAuditEvent(db, {
        event_type: 'hr.biometric.sync',
        entity_type: 'hr_smartoffice_sync',
        entity_id: `auto-${attemptIso}`,
        actor_email: SO_AUTO_SYNC_ACTOR,
        after: { from, to: next.last_to, ok, ...counts },
        note: ok ? 'automatic sync' : `automatic sync stopped part-way: ${message}`,
      });
    }

    return ok
      ? { outcome: 'ok', detail: `${from}→${next.last_to}: ${countsLine}` }
      : { outcome: 'failed', detail: message };
  } catch (e) {
    // Last-ditch: never throw into the scheduler tick.
    console.error('[smartoffice] auto-sync error:', errText(e));
    return { outcome: 'failed', detail: `Auto-sync error: ${errText(e)}` };
  }
}

/** A zeroed, failed SmartOfficeSyncResult (message filled in by the caller). */
function emptySyncResult(): SmartOfficeSyncResult {
  return {
    ok: false,
    message: '',
    fetched: 0,
    recorded: 0,
    already_recorded: 0,
    ignored_duplicates: 0,
    refused: [],
    unmatched: [],
  };
}
