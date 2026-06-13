/**
 * Google Sheets read client for the AKAN Party Manager sheet.
 *
 * Auth resolution (priority order — works on GCP, AWS, and a dev Mac):
 *   1. DB-stored service-account JSON (settings.google_sa_json) — set via the
 *      UI on Settings → Integrations. Highest priority because it's the
 *      operator's explicit choice, needs no SSH, and migrates with the DB.
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var → path to a JSON key file.
 *   3. GCP metadata server (compute service account) — auto on a GCE VM.
 *   4. `gcloud auth application-default login` on a dev Mac.
 *
 * The whole point: on AWS (no metadata server) you can paste the SA JSON in
 * the UI and Sheets access "just works" — no file management, no SSH.
 */

import { google } from 'googleapis';
import { getDb } from '@/lib/db';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

/** Lazy-init Sheets client. Cache is invalidated when the DB key changes
 *  (we key the cache on a small fingerprint of the active credential source). */
let cachedAuthClient: any = null;
let cachedFingerprint = '';

/** Read the pasted SA JSON from settings, or null. Never throws. */
function readDbCredJson(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'google_sa_json'`).get() as { value?: string } | undefined;
    const v = row?.value?.trim();
    return v && v.length > 10 ? v : null;
  } catch {
    return null;
  }
}

/** Fingerprint of the active credential source — changes when the operator
 *  pastes/clears a key, so the cached client refreshes automatically. */
function credFingerprint(): string {
  const dbKey = readDbCredJson();
  if (dbKey) return 'db:' + dbKey.length + ':' + dbKey.slice(0, 24);
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (env) return 'env:' + env;
  return 'adc';
}

// Cache the GoogleAuth wrapper too — getCredentials() lives on it and is the
// reliable way to read the active SA email across all auth modes.
let cachedAuth: any = null;

function buildAuth(): any {
  const dbKey = readDbCredJson();
  if (dbKey) {
    // Pasted JSON wins — authenticate directly from in-memory creds.
    const credentials = JSON.parse(dbKey);
    return new google.auth.GoogleAuth({ scopes: SCOPES, credentials });
  }
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  return new google.auth.GoogleAuth(
    keyFile ? { scopes: SCOPES, keyFile } : { scopes: SCOPES }
  );
}

async function getAuthClient() {
  const fp = credFingerprint();
  if (cachedAuthClient && fp === cachedFingerprint) return cachedAuthClient;
  cachedAuth = buildAuth();
  cachedAuthClient = await cachedAuth.getClient();
  cachedFingerprint = fp;
  return cachedAuthClient;
}

/** Force the next readSheet/diagnostic to re-init auth — call after the
 *  operator saves or clears the SA key in the UI. */
export function invalidateSheetsAuthCache(): void {
  cachedAuthClient = null;
  cachedAuth = null;
  cachedFingerprint = '';
}

/** Resolve the active service-account email via the GCE metadata server.
 *  Only used as a fallback when getCredentials() doesn't surface it. */
async function metadataSaEmail(): Promise<string | null> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) },
    );
    if (!res.ok) return null;
    const email = (await res.text()).trim();
    return email || null;
  } catch {
    return null;   // not on GCP, or metadata server unreachable
  }
}

/**
 * Diagnostic — report which Google identity the app will authenticate as, so
 * the UI can show the exact service-account email to share the sheet with.
 * Best-effort; never throws.
 */
export async function getAuthDiagnostics(): Promise<{
  mode: 'db-json' | 'keyfile' | 'adc-metadata' | 'unknown';
  service_account_email: string | null;
  key_file_path: string | null;
}> {
  // 1) DB-stored JSON
  const dbKey = readDbCredJson();
  if (dbKey) {
    try {
      const parsed = JSON.parse(dbKey);
      return { mode: 'db-json', service_account_email: parsed.client_email || null, key_file_path: null };
    } catch {
      return { mode: 'db-json', service_account_email: null, key_file_path: null };
    }
  }
  // 2) env keyFile
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || null;
  try {
    if (keyFile) {
      const fs = await import('fs');
      const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      return { mode: 'keyfile', service_account_email: raw.client_email || null, key_file_path: keyFile };
    }
    // 3) ADC / metadata — resolve the SA email reliably:
    //    a) auth.getCredentials() works for both JSON-ADC and metadata
    //    b) fall back to a direct metadata-server query on GCE
    await getAuthClient();                       // ensures cachedAuth is built
    let email: string | null = null;
    try {
      const creds = await cachedAuth?.getCredentials?.();
      email = creds?.client_email || null;
    } catch { /* getCredentials can throw off-GCP — fall through */ }
    if (!email) email = await metadataSaEmail();
    return { mode: 'adc-metadata', service_account_email: email, key_file_path: null };
  } catch {
    return { mode: keyFile ? 'keyfile' : 'unknown', service_account_email: null, key_file_path: keyFile };
  }
}

export async function readSheet(
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',  // raw numbers/dates as serials
    dateTimeRenderOption: 'FORMATTED_STRING', // but dates as human strings
  });
  return (res.data.values as string[][]) || [];
}
