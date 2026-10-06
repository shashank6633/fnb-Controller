/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import {
  fssaiAuditActionMeta, fssaiAuditEntityMeta, fssaiAuditDiff, fssaiAuditLine,
  FSSAI_AUDIT_OVERRIDE_ACTIONS,
} from '@/lib/fssai-audit';
import { fssaiTableExists } from '@/lib/fssai-void';

/**
 * THE CHANGE-AND-VOID TRAIL (/api/fssai/audit-log) — the owner's §19, read side.
 *
 *   GET ?id=<auditId>                       one line, with both JSON blobs in full
 *   GET [filters][&limit=&offset=]          the trail
 *   GET [filters]&format=csv                the same trail as a file
 *
 * Filters: entity_table · entity_id · action · actor · from · to · q · overrides
 *
 * ── READ-ONLY, AND THAT IS THE WHOLE POINT ──────────────────────────────────
 * This file holds no INSERT, no UPDATE and no DELETE — grep it. An audit trail
 * that the audit screen can write to is not a trail, and §19 asks for the
 * opposite of an editable history. Rows are written by the routes that make the
 * changes, inside their own transactions, and nothing here can reach them.
 *
 * ── MANAGEMENT ONLY, AND WHY ────────────────────────────────────────────────
 * This is a list of the moments somebody's record was overridden, with the reason
 * the manager typed. The catalog row says mgmtOnly, but the catalog is visibility
 * and never security (canAccessPage fails open four ways and page_access is NULL
 * on 8 of 9 live users), so the check that holds is the one below.
 *
 * ── TWO MEASURED TRAPS THIS ROUTE IS BUILT AROUND ───────────────────────────
 * 1. DATES ARE UTC IN THE COLUMN AND IST ON THE SCREEN. created_at is written by
 *    SQLite's own datetime('now'), i.e. UTC, as 'YYYY-MM-DD HH:MM:SS'. Filtering
 *    on date(created_at) would put every change made between midnight and 05:30
 *    IST on the previous day — the same class of defect that once parked ₹2.17 cr
 *    of sales in a fake 09:00 cell on /sales. Every date comparison here converts
 *    with the house modifier '+330 minutes'.
 * 2. SOME ROWS ARE ENORMOUS. A 'snapshot' row freezes an entire checklist sheet,
 *    and a 'void' row freezes the whole record. Shipping every blob in a list of
 *    200 would be megabytes, so the list TRUNCATES both blobs, says how long they
 *    really were, and the full pair is fetched one row at a time with ?id=.
 */
export const dynamic = 'force-dynamic';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
/** How much of each blob the list carries. The detail fetch has no cap. */
const BLOB_PREVIEW = 600;

const IST = `'+330 minutes'`;

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

interface Filters {
  entityTable: string;
  entityId: string;
  action: string;
  actor: string;
  from: string;
  to: string;
  q: string;
  overridesOnly: boolean;
}

function readFilters(url: URL): Filters {
  return {
    entityTable: str(url.searchParams.get('entity_table')),
    entityId: str(url.searchParams.get('entity_id')),
    action: str(url.searchParams.get('action')),
    actor: str(url.searchParams.get('actor')),
    from: str(url.searchParams.get('from')),
    to: str(url.searchParams.get('to')),
    q: str(url.searchParams.get('q')).trim(),
    overridesOnly: url.searchParams.get('overrides') === '1',
  };
}

/** The WHERE fragments and their parameters, in one place so every query agrees. */
function buildWhere(f: Filters): { sql: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];

  if (f.entityTable) { where.push(`a.entity_table = ?`); params.push(f.entityTable); }
  if (f.entityId) { where.push(`a.entity_id = ?`); params.push(f.entityId); }
  if (f.action) { where.push(`a.action = ?`); params.push(f.action); }
  if (f.actor) { where.push(`LOWER(a.actor_email) LIKE ?`); params.push(`%${f.actor.toLowerCase()}%`); }
  if (f.from) { where.push(`date(a.created_at, ${IST}) >= ?`); params.push(f.from); }
  if (f.to) { where.push(`date(a.created_at, ${IST}) <= ?`); params.push(f.to); }
  if (f.overridesOnly && FSSAI_AUDIT_OVERRIDE_ACTIONS.length) {
    where.push(`a.action IN (${FSSAI_AUDIT_OVERRIDE_ACTIONS.map(() => '?').join(',')})`);
    params.push(...FSSAI_AUDIT_OVERRIDE_ACTIONS);
  }
  if (f.q) {
    /* The reason comes first because it is the field this screen exists for: a
     * manager searching "wrong fridge" is looking for what somebody typed when
     * they cancelled a reading. The two blobs are searched too, which is how a
     * record is found by a value it used to hold. */
    where.push(
      `(a.reason LIKE ? OR a.entity_id LIKE ? OR LOWER(a.actor_email) LIKE ? OR LOWER(a.actor_name) LIKE ?
        OR a.field LIKE ? OR a.before_json LIKE ? OR a.after_json LIKE ?)`,
    );
    const like = `%${f.q}%`;
    params.push(like, like, `%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`, like, like, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function shapeRow(r: any, opts: { full: boolean }) {
  const action = fssaiAuditActionMeta(r.action);
  const entity = fssaiAuditEntityMeta(r.entity_table);
  const beforeLen = String(r.before_json || '').length;
  const afterLen = String(r.after_json || '').length;
  const before = opts.full ? String(r.before_json || '') : String(r.before_json || '').slice(0, BLOB_PREVIEW);
  const after = opts.full ? String(r.after_json || '') : String(r.after_json || '').slice(0, BLOB_PREVIEW);
  return {
    id: r.id,
    entity_table: r.entity_table,
    entity_id: r.entity_id,
    entity_one: entity.one,
    entity_many: entity.many,
    entity_path: entity.path,
    entity_is_record: entity.isRecord,
    action: r.action,
    action_label: action.label,
    action_means: action.means,
    action_color: action.color,
    is_override: !!action.isOverride,
    field: r.field || '',
    reason: r.reason || '',
    actor_email: r.actor_email || '',
    actor_name: r.actor_name || '',
    outlet_id: r.outlet_id || '',
    created_at: r.created_at,
    summary: fssaiAuditLine(r),
    before_json: before,
    after_json: after,
    before_bytes: beforeLen,
    after_bytes: afterLen,
    truncated: !opts.full && (beforeLen > BLOB_PREVIEW || afterLen > BLOB_PREVIEW),
    /* The field-by-field difference is computed on the SERVER from whatever the
     * row really holds, so the CSV and the screen can never tell two different
     * stories about the same line. On a truncated list row it is computed from
     * the FULL text, not the preview — a diff built from half a JSON blob would
     * be a lie, and it is the one thing §19(b) actually asks for. */
    changes: fssaiAuditDiff(r.before_json, r.after_json),
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  if (!isManagement(me)) {
    return Response.json(
      { error: 'The record-change trail is for managers and administrators.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    if (!fssaiTableExists(db, 'fssai_audit_log')) {
      /* HARD RULE 7: initializeSchema swallows schema errors per block, so a
       * missing table is a real state and not an impossible one. Say so plainly
       * instead of returning an empty list that reads as "nothing ever changed". */
      return Response.json(
        { error: 'The food-safety change trail is not in this database yet. It appears on the next restart.' },
        { status: 409 },
      );
    }

    const url = new URL(request.url);

    /* ══ ONE LINE, IN FULL ═════════════════════════════════════════════════ */
    const one = str(url.searchParams.get('id'));
    if (one) {
      const row = db.prepare(`SELECT a.* FROM fssai_audit_log a WHERE a.id = ?`).get(one) as any;
      if (!row) return Response.json({ error: 'That trail entry no longer exists.' }, { status: 404 });
      return Response.json({ entry: shapeRow(row, { full: true }) });
    }

    const f = readFilters(url);
    const { sql: whereSql, params } = buildWhere(f);
    const asCsv = url.searchParams.get('format') === 'csv';

    const limit = asCsv
      ? 5000
      : Math.min(PAGE_MAX, Math.max(1, Number(url.searchParams.get('limit')) || PAGE_DEFAULT));
    const offset = asCsv ? 0 : Math.max(0, Number(url.searchParams.get('offset')) || 0);

    /* rowid breaks the tie: several rows can share a created_at to the second
     * (one transaction writes a change and its snapshot together) and an unstable
     * sort would show the same row on two pages and skip another. */
    const rows = db.prepare(
      `SELECT a.* FROM fssai_audit_log a ${whereSql}
        ORDER BY a.created_at DESC, a.rowid DESC
        LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as any[];

    const total = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_audit_log a ${whereSql}`,
    ).get(...params) as any).n as number;

    if (asCsv) {
      const header = [
        'when_utc', 'register', 'record_id', 'what_happened', 'field',
        'original_value', 'changed_value', 'reason', 'by_email', 'by_name',
      ];
      const lines = [header.join(',')];
      for (const r of rows) {
        const shaped = shapeRow(r, { full: true });
        /* One line per CHANGED FIELD, not one per audit row: "original vs
         * changed" is what §19(b) asks for, and a spreadsheet cell holding a
         * whole JSON blob answers nobody's question. A row with no readable
         * blobs still produces its own line so nothing disappears from the file. */
        const changes = shaped.changes.length
          ? shaped.changes
          : [{ field: shaped.field, before: '', after: '', oneSided: false }];
        for (const c of changes) {
          lines.push([
            shaped.created_at, shaped.entity_table, shaped.entity_id, shaped.action_label,
            c.field, c.before, c.after, shaped.reason, shaped.actor_email, shaped.actor_name,
          ].map(csvEscape).join(','));
        }
      }
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="fssai-record-changes-${stamp}.csv"`,
        },
      });
    }

    /* ══ THE SUMMARY — counted over the SAME filters, never over the page ═══ */
    const counts = db.prepare(
      `SELECT
         COUNT(*)                                        AS total,
         COUNT(DISTINCT a.actor_email)                   AS actors,
         COUNT(DISTINCT a.entity_table || ':' || a.entity_id) AS records,
         MIN(date(a.created_at, ${IST}))                 AS first_day,
         MAX(date(a.created_at, ${IST}))                 AS last_day
       FROM fssai_audit_log a ${whereSql}`,
    ).get(...params) as any;

    const overrides = FSSAI_AUDIT_OVERRIDE_ACTIONS.length
      ? (db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_audit_log a ${whereSql ? `${whereSql} AND` : 'WHERE'}
           a.action IN (${FSSAI_AUDIT_OVERRIDE_ACTIONS.map(() => '?').join(',')})`,
      ).get(...params, ...FSSAI_AUDIT_OVERRIDE_ACTIONS) as any).n as number
      : 0;

    const voided = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_audit_log a ${whereSql ? `${whereSql} AND` : 'WHERE'} a.action = 'void'`,
    ).get(...params) as any).n as number;

    const noReason = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_audit_log a ${whereSql ? `${whereSql} AND` : 'WHERE'}
         a.action = 'void' AND TRIM(COALESCE(a.reason, '')) = ''`,
    ).get(...params) as any).n as number;

    /* ══ FACETS — what is actually in the trail, so a dropdown cannot offer a
     *    filter that returns nothing. Deliberately NOT narrowed by the current
     *    entity_table/action filter, or choosing one register would empty the
     *    other's list and there would be no way back. The date range IS applied,
     *    because a period is the one filter a reader thinks of as "where I am". */
    const periodWhere = buildWhere({
      ...f, entityTable: '', entityId: '', action: '', actor: '', q: '', overridesOnly: false,
    });
    const tableFacets = db.prepare(
      `SELECT a.entity_table AS k, COUNT(*) AS n FROM fssai_audit_log a ${periodWhere.sql}
        GROUP BY a.entity_table ORDER BY n DESC`,
    ).all(...periodWhere.params) as any[];
    const actionFacets = db.prepare(
      `SELECT a.action AS k, COUNT(*) AS n FROM fssai_audit_log a ${periodWhere.sql}
        GROUP BY a.action ORDER BY n DESC`,
    ).all(...periodWhere.params) as any[];

    return Response.json({
      rows: rows.map((r) => shapeRow(r, { full: false })),
      total,
      limit,
      offset,
      has_more: offset + rows.length < total,
      filters: f,
      summary: {
        total: Number(counts?.total) || 0,
        actors: Number(counts?.actors) || 0,
        records: Number(counts?.records) || 0,
        overrides,
        voided,
        /* A cancellation with no reason is the one thing this screen should be
         * able to find in one click. It should always be 0 — every void path in
         * the module demands four characters — so a non-zero number here is a
         * defect report, not a statistic. */
        voided_without_reason: noReason,
        first_day: counts?.first_day || '',
        last_day: counts?.last_day || '',
      },
      facets: {
        tables: tableFacets.map((r) => ({
          key: r.k, count: Number(r.n) || 0, label: fssaiAuditEntityMeta(r.k).many,
        })),
        actions: actionFacets.map((r) => ({
          key: r.k, count: Number(r.n) || 0, label: fssaiAuditActionMeta(r.k).label,
        })),
      },
      blob_preview_chars: BLOB_PREVIEW,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/audit-log failed:', e);
    return Response.json({ error: e?.message || 'Could not read the change trail.' }, { status: 500 });
  }
}
