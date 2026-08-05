import { cookies } from 'next/headers';
import { createHash } from 'crypto';
import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import { guardSql } from '@/lib/sql-guard';
import {
  MAX_ROWS,
  MAX_EXPORT_ROWS,
  getCatalog,
  getTableSchema,
  SAVED_QUERIES,
  composeBrowseSql,
  runQuery,
  maskResult,
} from '@/lib/db-explorer';

/**
 * Read-only Database console — ADMIN ONLY.
 *
 *   GET  /api/admin/database?view=catalog            table list + row counts, grouped
 *   GET  /api/admin/database?view=schema&table=…     columns / PK / FKs / indexes
 *   GET  /api/admin/database?view=saved              the canned queries
 *   POST /api/admin/database                         { mode: browse | saved | sql }
 *
 * WHY THE PATH IS /api/admin/*: '/api/admin' is already in CSRF_REQUIRED_PREFIXES
 * (src/proxy.ts:59), so every POST here is CSRF-checked by the proxy with no edit
 * to that file, AND the proxy validates the session token against the `sessions`
 * table before the handler runs. Do not "tidy" this route to /api/database —
 * that silently drops both. The CSRF check is repeated inside POST below as a
 * second layer, so a future reshuffle of the prefix list cannot leave this
 * endpoint bare.
 *
 * NOTHING in this file executes user SQL directly. Every row the owner sees comes
 * back from src/lib/db-explorer, which runs the statement in a SHORT-LIVED CHILD
 * PROCESS on a `{ readonly: true, fileMustExist: true }` handle — never getDb().
 * getDb() appears exactly once here, for the audit INSERT (see AUDIT_ENABLED).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CSRF_COOKIE = 'fnb_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * RULE 3 ("this feature must never write to the database") vs CONTROL F
 * ("audit every query"). They pull against each other, so the tension is named
 * here rather than quietly resolved: rule 3 governs the QUERY SURFACE — no
 * user-supplied SQL may ever mutate anything, and that is enforced at the
 * driver, not by this flag. Control F requires one server-controlled append.
 *
 * So the feature performs exactly ONE write: a fixed prepared INSERT into the
 * append-only audit_events table, with no user-controlled SQL anywhere in it,
 * identical to what every other privileged action in this app already does.
 * If the owner decides he wants literally zero writes, flip this to false — and
 * accept that "who ran that query" then has no answer.
 */
const AUDIT_ENABLED = true;

/** Refusal/failure code → HTTP status. Anything unlisted is a 400 (bad input). */
const STATUS_BY_CODE: Record<string, number> = {
  TIMEOUT: 408,
  RESULT_TOO_LARGE: 413,
  BUSY: 429,
  SQLITE_ERROR: 500,
};
const statusFor = (code: string) => STATUS_BY_CODE[code] ?? 400;

const fail = (status: number, code: string, error: string) =>
  Response.json({ code, error }, { status, headers: { 'Cache-Control': 'no-store' } });

/** Stable fingerprint of a statement, so "who else ran this" is a groupable question. */
const sqlFingerprint = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Filenames land on a Windows counter PC — keep them boring. */
const safeFilename = (s: string) => (s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'query');

// ---------------------------------------------------------------------------
// GET — metadata only. Returns no table ROWS, so it is deliberately not audited
// (stated gap: the table list and a column list are not data).
// ---------------------------------------------------------------------------
export async function GET(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) {
    return fail(gate.status, gate.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', gate.message);
  }

  try {
    const qs = new URL(request.url).searchParams;
    const view = qs.get('view') || 'catalog';

    if (view === 'catalog') {
      return Response.json(await getCatalog(), { headers: { 'Cache-Control': 'no-store' } });
    }

    if (view === 'schema') {
      const table = qs.get('table') || '';
      // getTableSchema validates `table` against the live sqlite_master list before
      // it composes anything — an unknown name never reaches an identifier.
      const schema = await getTableSchema(table);
      if (!schema) {
        return fail(404, 'NO_SUCH_TABLE', `There is no table named "${table}" in this database.`);
      }
      return Response.json(schema, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (view === 'saved') {
      return Response.json({ saved: SAVED_QUERIES }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return fail(400, 'BAD_VIEW', `Unknown view "${view}". Use view=catalog, view=schema&table=… or view=saved.`);
  } catch (e: any) {
    console.error('[db-console] GET failed:', e?.message);
    return fail(500, 'SERVER_ERROR', e?.message || 'Database console failed to read the schema.');
  }
}

// ---------------------------------------------------------------------------
// POST — the only path that returns table rows. browse | saved | sql.
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) {
    return fail(gate.status, gate.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', gate.message);
  }
  const user = gate.user;

  // Second CSRF layer. The proxy already enforced this for the /api/admin prefix
  // and answered first — this repeat exists so that if someone ever reorganises
  // CSRF_REQUIRED_PREFIXES, the SQL console does not quietly become the one
  // state-changing-looking endpoint a cross-site page can poke.
  const jar = await cookies();
  const cookieToken = jar.get(CSRF_COOKIE)?.value;
  const headerToken = request.headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return fail(403, 'CSRF', 'CSRF token missing or mismatched. Refresh the page.');
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_BODY', 'Request body must be JSON.');
  }

  // Stamped on the audit row so a multi-outlet log can be filtered the same way
  // every other audited action in this app can be. Read-only (a SELECT on users
  // / outlets), so it does not widen the one-write rule below.
  const outletId = await getCurrentOutletId();

  const mode: string = String(body?.mode || '');
  const format: string = body?.format === 'csv' ? 'csv' : 'json';
  // The export cap is higher than the screen cap because a CSV is read offline,
  // but it is still a CAP — and the wall-clock SIGKILL applies either way.
  const rowCap = format === 'csv' ? MAX_EXPORT_ROWS : MAX_ROWS;

  try {
    let sql = '';
    let params: unknown[] = [];
    let source = 'console';
    let browseMeta: { total_rows: number; page: number; page_size: number } | null = null;
    let filenameStem = 'query';

    if (mode === 'browse') {
      // The client NEVER sends SQL in this mode. It sends a table name, a column
      // name and a direction; composeBrowseSql whitelists all three against the
      // real sqlite_master / pragma_table_info lists and only then quotes them
      // into an identifier. That is why `sort_column: "; DROP TABLE x"` is a
      // NO_SUCH_COLUMN 400 and not a parser problem.
      const table = String(body?.table ?? '');
      const composed = await composeBrowseSql({
        table,
        sort_column: body?.sort_column ?? null,
        sort_dir: body?.sort_dir ?? null,
        page: Number(body?.page) || 0,
        // "Download the current view" — so a CSV of a browse is whatever page
        // size the client asks for, clamped by composeBrowseSql to max_rows.
        // The client sends the visible page size for a page export, or the
        // export cap when he wants the whole table.
        page_size: Number(body?.page_size) || 100,
        max_rows: rowCap,
      });
      if (!composed.ok) return fail(statusFor(composed.code), composed.code, composed.error);
      sql = composed.sql;
      params = composed.params;
      source = `browse:${table}`;
      filenameStem = table;
      browseMeta = { total_rows: composed.total_rows, page: composed.page, page_size: composed.page_size };

    } else if (mode === 'saved') {
      // Only an id crosses the wire; the SQL is a server constant. A saved query
      // is therefore not a way to smuggle text past guardSql.
      const id = String(body?.id ?? '');
      const saved = SAVED_QUERIES.find((q) => q.id === id);
      if (!saved) {
        return fail(400, 'NO_SUCH_SAVED_QUERY', `There is no saved query with the id "${id}".`);
      }
      sql = saved.sql;
      source = `saved:${id}`;
      filenameStem = id;

    } else if (mode === 'sql') {
      sql = typeof body?.sql === 'string' ? body.sql : '';
      source = 'console';
      filenameStem = 'sql-console';

      // THE ONLY PLACE user SQL text is accepted. guardSql runs BEFORE anything
      // touches a database handle. If you are here to "simplify" it: the readonly
      // driver alone is NOT enough — CREATE TEMP TABLE, PRAGMA writable_schema=ON
      // and ATTACH of another readable file all SUCCEED on a readonly handle
      // (measured against this very database). The parser is what stops those,
      // and it is what stops `WITH x AS (…) DELETE FROM …`, which SQLite's
      // grammar allows even though the statement starts with WITH.
      const verdict = guardSql(sql);
      if (!verdict.ok) {
        // A refusal is still an event worth having in the log: it is the shape
        // of a mistake, and of an attempt.
        audit({
          actor_email: user.email, outlet_id: outletId,
          event_type: 'database.query_refused', sql, source,
          rows_returned: 0, truncated: false, elapsed_ms: 0, masked_cells: 0, format,
          note: `${verdict.code}: ${verdict.message}`,
        });
        return fail(statusFor(verdict.code), verdict.code, verdict.message);
      }

    } else {
      return fail(400, 'BAD_MODE', `Unknown mode "${mode}". Use mode: 'browse', 'saved' or 'sql'.`);
    }

    // runQuery spawns a short-lived child process on its own readonly handle and
    // SIGKILLs it at the deadline. It is the only executor; all three modes land
    // here, which is what makes "audit every query" true rather than aspirational.
    const result = await runQuery(sql, { params, maxRows: rowCap });

    if (!result.ok) {
      audit({
        actor_email: user.email, outlet_id: outletId,
        event_type: 'database.query', sql, source,
        rows_returned: 0, truncated: false, elapsed_ms: result.elapsed_ms, masked_cells: 0, format,
        note: `${result.code}: ${result.error}`,
      });
      return fail(statusFor(result.code), result.code, result.error);
    }

    // Masking happens server-side, after the child returns and before anything is
    // serialised — so it applies identically to the JSON grid and to the CSV.
    // Without it a single `SELECT * FROM settings` walks straight around the
    // redaction /api/settings performs, and hands over the live TeleCMI secret,
    // the Meta WhatsApp token and the Google service-account JSON in one screen.
    const masked = await maskResult(result.columns, result.rows);

    audit({
      actor_email: user.email, outlet_id: outletId,
      event_type: format === 'csv' ? 'database.export' : 'database.query',
      sql, source,
      rows_returned: masked.rows.length,
      truncated: result.truncated,
      elapsed_ms: result.elapsed_ms,
      masked_cells: masked.masked.length,
      format,
    });

    if (format === 'csv') {
      const header = result.columns.map((c) => c.name);
      const lines = [header.map(csvCell).join(',')];
      for (const row of masked.rows) lines.push(header.map((h) => csvCell(row[h])).join(','));
      const stamp = new Date().toISOString().slice(0, 10);
      // Trailing newline + no BOM, matching the app's other CSV exports
      // (src/app/api/menu-items/export/route.ts:58).
      return new Response(lines.join('\n') + '\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeFilename(filenameStem)}_${stamp}.csv"`,
          // A CSV body has nowhere honest to say "this is only part of the
          // result", so the fact is carried in headers instead of being dropped.
          // The UI reads X-Truncated to warn before he treats the file as complete.
          'X-Row-Count': String(masked.rows.length),
          'X-Truncated': result.truncated ? '1' : '0',
          'X-Masked-Cells': String(masked.masked.length),
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({
      columns: result.columns,
      rows: masked.rows,
      row_count: masked.rows.length,
      truncated: result.truncated,
      elapsed_ms: result.elapsed_ms,
      masked: masked.masked,
      // Echoed for browse + saved too: nothing on this page is a black box. He can
      // read the real statement, copy it into the console and edit it.
      sql_executed: sql,
      ...(browseMeta || {}),
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch (e: any) {
    console.error('[db-console] POST failed:', e?.message);
    return fail(500, 'SERVER_ERROR', e?.message || 'The database console failed to run that query.');
  }
}

// ---------------------------------------------------------------------------
// The one write in the whole feature. See AUDIT_ENABLED above for why it exists
// despite the read-only rule. Never throws (logAuditEvent swallows), so a broken
// audit table can never take the console down — but it does log to the console.
// ---------------------------------------------------------------------------
function audit(a: {
  actor_email: string;
  outlet_id: string | null;
  event_type: 'database.query' | 'database.export' | 'database.query_refused';
  sql: string;
  source: string;
  rows_returned: number;
  truncated: boolean;
  elapsed_ms: number;
  masked_cells: number;
  format: string;
  note?: string;
}): void {
  if (!AUDIT_ENABLED) return;
  try {
    logAuditEvent(getDb(), {
      event_type: a.event_type,
      entity_type: 'database',
      entity_id: sqlFingerprint(a.sql),
      actor_email: a.actor_email,
      outlet_id: a.outlet_id,
      after: {
        // Truncated: the audit row must stay a LOG LINE, not a second copy of the
        // payload. 2000 chars is well past the 4000-char guard cap's useful part
        // and keeps audit_events from growing into a query archive.
        sql: a.sql.slice(0, 2000),
        source: a.source,
        rows_returned: a.rows_returned,
        truncated: a.truncated,
        elapsed_ms: a.elapsed_ms,
        masked_cells: a.masked_cells,
        format: a.format,
      },
      note: a.note || '',
    });
  } catch (e: any) {
    console.error('[db-console] audit failed:', e?.message);
  }
}
