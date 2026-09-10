/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { GBP_KEYS, connectionHealth, ensureReviewSchema, getConnection, hasOauthApp } from '@/lib/reviews';
import { reviewSetting } from '@/lib/reviews/schema';

/**
 * CRM — Google Reviews page settings (GET/PUT /api/crm-calls/reviews/settings).
 * ADMIN ONLY, both verbs.
 *
 * Three non-secret values the page itself needs, and nothing else:
 *
 *   reviews_place_id      the listing's Google Place ID. With it, every review
 *                         row can offer a working "reply on Google" link
 *                         (search.google.com/local/reviews?placeid=...).
 *   reviews_listing_url   a plain https link, for the owner who has the Maps
 *                         URL to hand and not the Place ID.
 *   reviews_stale_hours   how old the last import may be before the page calls
 *                         itself stale. Blank = the default (7 days for a
 *                         manual import, 2 days for the API connector).
 *
 * ── WHAT THIS ROUTE DELIBERATELY WILL NOT WRITE ─────────────────────────────
 * The Google credentials. reviews_gbp_client_secret and
 * reviews_gbp_refresh_token both match SECRET_KEY_RE by shape, so the existing
 * admin settings surface already masks them, gates them and audits them. Adding
 * a second door that accepts the same secrets would mean a second place to get
 * masking wrong for no gain — the allowlist below is exhaustive and rejects
 * anything not on it, including those two by name.
 *
 * GET reports only WHETHER each credential is present, never a prefix, length
 * or fragment of one.
 */

export const dynamic = 'force-dynamic';

/** Exhaustive. A key not on this list is refused, not ignored. */
const ALLOWED = ['reviews_place_id', 'reviews_listing_url', 'reviews_stale_hours'] as const;
type AllowedKey = (typeof ALLOWED)[number];

function isAllowed(k: string): k is AllowedKey {
  return (ALLOWED as readonly string[]).includes(k);
}

export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = ensureReviewSchema(getDb());
  return Response.json({
    settings: {
      reviews_place_id: reviewSetting(db, 'reviews_place_id'),
      reviews_listing_url: reviewSetting(db, 'reviews_listing_url'),
      reviews_stale_hours: reviewSetting(db, 'reviews_stale_hours'),
    },
    // Presence only. Never the values, never a prefix of them.
    gbp: {
      client_id_set: !!reviewSetting(db, GBP_KEYS.clientId, process.env.GBP_CLIENT_ID || '').trim(),
      client_secret_set: !!reviewSetting(db, GBP_KEYS.clientSecret, process.env.GBP_CLIENT_SECRET || '').trim(),
      refresh_token_set: !!reviewSetting(db, GBP_KEYS.refreshToken, process.env.GBP_REFRESH_TOKEN || '').trim(),
      /* The chosen listing now lives on gr_connection, put there by the OAuth
       * connect flow. The legacy pasted setting is still honoured as a
       * fallback so a hand-configured install keeps working — reading only
       * that key would report "no listing" for every account connected
       * properly, which is the opposite of the truth. */
      location_set: !!(getConnection(db, '').location_name ||
                       reviewSetting(db, GBP_KEYS.parent, process.env.GBP_LOCATION || '').trim()),
      keys: GBP_KEYS,
    },
    /* Connecting, disconnecting and choosing a listing are NOT done here —
     * they are /api/crm-calls/reviews/connect and .../locations. This route
     * only carries the three page preferences above. */
    connection: connectionHealth(getConnection(db, ''), { hasApp: hasOauthApp(db) }),
  });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const body = await req.json().catch(() => ({} as any));
  const incoming = (body && typeof body === 'object' ? body.settings : null) as Record<string, unknown> | null;
  if (!incoming || typeof incoming !== 'object') {
    return Response.json({ error: 'Expected { settings: { … } }' }, { status: 400 });
  }

  const writes: Array<[AllowedKey, string]> = [];
  for (const [k, raw] of Object.entries(incoming)) {
    if (!isAllowed(k)) {
      return Response.json({ error: `“${k}” is not a setting this page may write.` }, { status: 400 });
    }
    const v = String(raw ?? '').trim().slice(0, 500);

    if (k === 'reviews_listing_url' && v && !/^https:\/\//i.test(v)) {
      return Response.json({ error: 'The listing URL must start with https://' }, { status: 400 });
    }
    if (k === 'reviews_place_id' && v && !/^[A-Za-z0-9_\-:.]{4,255}$/.test(v)) {
      return Response.json({ error: 'That does not look like a Google Place ID (letters, digits, - _ : . only).' }, { status: 400 });
    }
    if (k === 'reviews_stale_hours' && v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 8760) {
        return Response.json({ error: 'Stale-after must be a number of hours between 1 and 8760, or blank for the default.' }, { status: 400 });
      }
    }
    writes.push([k, v]);
  }

  const db = ensureReviewSchema(getDb());
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const apply = db.transaction((rows: Array<[string, string]>) => {
    for (const [k, v] of rows) stmt.run(k, v);
  });
  apply(writes);

  return Response.json({ ok: true, saved: writes.map(([k]) => k) });
}
