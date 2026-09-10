/**
 * GOOGLE REVIEWS — the source registry, and the manual sources.
 *
 * ── WHICH SOURCE IS THE PRODUCT ─────────────────────────────────────────────
 * gbp_api is. The owner was explicit: "it should automatically retrieve the
 * reviews data... how can we import every time?" A feature that needs a file
 * uploaded every day is a feature nobody uses by week two. So the automatic
 * connector (./sources-gbp.ts, driven by ./refresh.ts) is the primary path, and
 * a screen should present it as the obvious thing to do.
 *
 * ── WHY THE MANUAL SOURCES STILL EXIST, AND ARE NOT SCAFFOLDING ─────────────
 * They are the BACKFILL and the FALLBACK, which are two real jobs:
 *
 *   BACKFILL  the connector pulls a full history on its first run, but only for
 *             the listing it is connected to. Anything the owner has from
 *             before — an older export, a spreadsheet someone kept — lands here.
 *   FALLBACK  Google's Business Profile API needs an application approved on no
 *             published timetable, and the refresh token can be refused later
 *             (a consent screen left in Testing expires it every 7 days). On
 *             either of those days the manual path still works, with no
 *             credential, no approval and no network.
 *
 *   takeout_json / csv / paste  — ready the moment someone has a file.
 *   gbp_api                     — same rows, fetched on a schedule.
 *
 * Because every source feeds ONE parse -> ingest pipeline keyed on ONE identity,
 * a Takeout import and an API pull DE-DUPLICATE AGAINST EACH OTHER. A backfill
 * and the connector can therefore run on the same listing, in either order,
 * without double-counting a single review. That property is what makes the
 * secondary path safe to keep rather than something to migrate off.
 */
import type Database from 'better-sqlite3';
import type { CollectOptions, RawDocument, ReviewSource, ReviewSourceKey, SourceStatus } from './types';
import { detectKind } from './parse';
import { gbpSource } from './sources-gbp';

/* ── Manual sources ───────────────────────────────────────────────────────── */

/**
 * A manual source does not fetch. It hands back the documents the caller
 * already has — an uploaded file, a pasted block — so that an upload and an API
 * pull travel the identical code path from here on.
 *
 * Its status() is unconditionally ready, and that is the property worth having:
 * there is no state in which the owner cannot get his reviews into this system,
 * including the weeks before Google approves API access and any day the token
 * breaks afterwards.
 */
function manualSource(key: ReviewSourceKey, label: string, note: string): ReviewSource {
  return {
    key,
    label,
    kind: 'manual',
    status(): SourceStatus {
      return { ready: true, reason: note, prerequisites: [], unproven: [] };
    },
    async collect(opts: CollectOptions): Promise<RawDocument[]> {
      const docs = opts.documents || [];
      return docs.map(d => ({
        kind: d.kind || detectKind(d.payload),
        payload: d.payload,
        label: d.label || 'upload',
      }));
    },
  };
}

export const takeoutSource = manualSource(
  'takeout_json',
  'Google Takeout export (reviews.json) — backfill',
  'Sign in at takeout.google.com as the account that manages the listing, deselect all, ' +
  'select Google Business Profile, export, and upload the reviews.json for this location. ' +
  'Takeout produces JSON only — there is no CSV or Excel option — and it does not include ' +
  'review photos. Nothing has to be approved by Google first.',
);

export const csvSource = manualSource(
  'csv',
  'CSV / spreadsheet upload — backfill',
  'Any CSV, TSV or spreadsheet export with a rating column and a date column. Column names ' +
  'are matched loosely, and the mapping the importer chose is shown back before the rows count.',
);

export const pasteSource = manualSource(
  'paste',
  'Pasted text — backfill',
  'Paste rows copied out of a sheet. Tab-separated paste is detected automatically.',
);

/* ── Registry ─────────────────────────────────────────────────────────────── */

export function reviewSources(db?: Database.Database): ReviewSource[] {
  return [takeoutSource, csvSource, pasteSource, gbpSource(db)];
}

export function reviewSource(key: ReviewSourceKey, db?: Database.Database): ReviewSource {
  const found = reviewSources(db).find(s => s.key === key);
  if (!found) throw new Error(`Unknown review source: ${key}`);
  return found;
}

/**
 * What a settings page should render: every source, whether it can run right
 * now, and — for the one that cannot — the owner's own to-do list rather than
 * an error. "Not configured" here is a paperwork state, not a fault.
 */
export function sourceReadiness(db?: Database.Database): Array<SourceStatus & { key: ReviewSourceKey; label: string; kind: 'manual' | 'api' }> {
  return reviewSources(db).map(s => ({ key: s.key, label: s.label, kind: s.kind, ...s.status() }));
}
