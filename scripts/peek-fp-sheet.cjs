/**
 * One-shot script to peek at rows 61-63 of the AKAN Party Manager sheet
 * via Application Default Credentials (no key file needed).
 */
const { google } = require('googleapis');

const SHEET_ID = '1VYpxSOjcHHRPkBb7f7s1bfBFcl-M25PnxkjpEdXFbJI';
const TAB_NAME = 'F&P Records';

(async () => {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // First — headers (row 1)
  const headers = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!1:1`,
  });
  const headerRow = headers.data.values?.[0] || [];

  // Then — rows 61-63
  const rows = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!61:63`,
  });
  const dataRows = rows.data.values || [];

  console.log('━━━ HEADERS ━━━');
  headerRow.forEach((h, i) => console.log(`  [${i}] ${h}`));

  console.log('\n━━━ ROW 61 ━━━');
  if (dataRows[0]) {
    dataRows[0].forEach((v, i) => {
      if (v !== '' && v != null) console.log(`  ${headerRow[i] || '?'.padEnd(30)} = ${String(v).slice(0, 100)}`);
    });
  }
  console.log('\n━━━ ROW 62 ━━━');
  if (dataRows[1]) {
    dataRows[1].forEach((v, i) => {
      if (v !== '' && v != null) console.log(`  ${headerRow[i] || '?'.padEnd(30)} = ${String(v).slice(0, 100)}`);
    });
  }
  console.log('\n━━━ ROW 63 ━━━');
  if (dataRows[2]) {
    dataRows[2].forEach((v, i) => {
      if (v !== '' && v != null) console.log(`  ${headerRow[i] || '?'.padEnd(30)} = ${String(v).slice(0, 100)}`);
    });
  }
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
