import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { readSheet, getAuthDiagnostics, invalidateSheetsAuthCache } from '@/lib/sheets-client';

/**
 * Google Sheets integration management — powers the card on
 * Settings → Integrations. Lets an admin:
 *   - see the current auth status + the exact service-account email to share
 *   - TEST the live connection (reads 1 row, reports success/row-count/error)
 *   - PASTE a service-account JSON key (stored in settings.google_sa_json) so
 *     Sheets access works on AWS without any SSH / file management
 *   - CLEAR the stored key
 *
 * GET  → status (no secrets leaked — only client_email + configured flag)
 * POST → { action: 'test' | 'save_key' | 'clear_key', json? }   admin only for mutations
 */
export const dynamic = 'force-dynamic';

// Same sheet the rest of the app reads. Kept here for the test probe.
const SHEET_ID = '1VYpxSOjcHHRPkBb7f7s1bfBFcl-M25PnxkjpEdXFbJI';
const TEST_RANGE = "'F&P Records'!A1:A2";   // tiny read — just proves access

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'google_sa_json'`).get() as { value?: string } | undefined;
    const hasDbKey = !!stored?.value?.trim();
    const diag = await getAuthDiagnostics().catch(() => null);
    const lastTest = db.prepare(`SELECT value FROM settings WHERE key = 'google_sheets_last_test'`).get() as { value?: string } | undefined;

    return Response.json({
      spreadsheet_id: SHEET_ID,
      auth_mode: diag?.mode || 'unknown',
      service_account_email: diag?.service_account_email || null,
      key_file_path: diag?.key_file_path || null,
      db_key_configured: hasDbKey,
      last_test: lastTest?.value ? JSON.parse(lastTest.value) : null,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || '');

    // ── TEST: read one row from the sheet, report exactly what happened ──
    if (action === 'test') {
      const diag = await getAuthDiagnostics().catch(() => null);
      try {
        const rows = await readSheet(SHEET_ID, TEST_RANGE);
        const result = {
          ok: true,
          rows_read: rows.length,
          service_account_email: diag?.service_account_email || null,
          auth_mode: diag?.mode || 'unknown',
          tested_at: new Date().toISOString(),
        };
        db.prepare(`INSERT INTO settings (key, value) VALUES ('google_sheets_last_test', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(result));
        return Response.json(result);
      } catch (e: any) {
        const result = {
          ok: false,
          error: e.message || 'Sheet read failed',
          service_account_email: diag?.service_account_email || null,
          auth_mode: diag?.mode || 'unknown',
          tested_at: new Date().toISOString(),
        };
        db.prepare(`INSERT INTO settings (key, value) VALUES ('google_sheets_last_test', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(result));
        // 200 with ok:false — the test ran; it's the sheet that failed, not the API.
        return Response.json(result);
      }
    }

    // Mutations below are admin-only.
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    // ── SAVE KEY: validate the pasted JSON, store it, invalidate auth cache ──
    if (action === 'save_key') {
      const json = String(body?.json || '').trim();
      if (!json) return Response.json({ error: 'Paste the service-account JSON key.' }, { status: 400 });
      let parsed: any;
      try { parsed = JSON.parse(json); }
      catch { return Response.json({ error: 'That is not valid JSON. Paste the full key file contents.' }, { status: 400 }); }
      // Sanity-check it's actually a service-account key.
      if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
        return Response.json({
          error: 'Not a service-account key. Expected fields type="service_account", client_email, private_key.',
        }, { status: 400 });
      }
      db.prepare(`INSERT INTO settings (key, value) VALUES ('google_sa_json', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(json);
      invalidateSheetsAuthCache();
      // Immediately test so the user gets instant pass/fail feedback.
      let test: any = null;
      try {
        const rows = await readSheet(SHEET_ID, TEST_RANGE);
        test = { ok: true, rows_read: rows.length };
      } catch (e: any) {
        test = { ok: false, error: e.message };
      }
      return Response.json({
        ok: true,
        client_email: parsed.client_email,
        project_id: parsed.project_id || null,
        test,
        note: test?.ok
          ? 'Key saved and connection verified.'
          : `Key saved, but the test read failed: ${test?.error}. Share the sheet (Viewer) with ${parsed.client_email}.`,
      });
    }

    // ── CLEAR KEY ──
    if (action === 'clear_key') {
      db.prepare(`DELETE FROM settings WHERE key = 'google_sa_json'`).run();
      invalidateSheetsAuthCache();
      return Response.json({ ok: true, note: 'Stored key removed. Falling back to env var / metadata server.' });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/admin/google-sheets]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
