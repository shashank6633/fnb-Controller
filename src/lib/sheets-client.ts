/**
 * Google Sheets read client for the AKAN Party Manager sheet.
 *
 * Auth: Application Default Credentials (ADC).
 *   - On the VM: auto-discovered via the GCE metadata server, using the
 *     compute service account (which has cloud-platform scope).
 *   - On a Mac with `gcloud auth application-default login`: uses the user's
 *     OAuth token. May fail if the gcloud OAuth client is blocked by org
 *     policy — in that case, deploy and test on the VM.
 *
 * No JSON key files needed (org policy blocks key creation anyway).
 */

import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

/** Lazy-init Sheets client — reuses the same auth object across calls. */
let cachedAuthClient: any = null;

async function getAuthClient() {
  if (cachedAuthClient) return cachedAuthClient;
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  cachedAuthClient = await auth.getClient();
  return cachedAuthClient;
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
