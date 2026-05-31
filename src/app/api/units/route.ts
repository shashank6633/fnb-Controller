import { getDb } from '@/lib/db';
import { applyRegistryRows, Dimension } from '@/lib/units';
import { getCurrentUser } from '@/lib/auth';

/**
 * Units registry CRUD.
 *
 * GET    /api/units                → list all units
 * POST   /api/units                 admin
 *        body: { key, label, aliases?, dimension, to_base }
 *        Adds a new unit. `key` must be unique. Aliases can be array or comma-separated string.
 * PUT    /api/units                 admin
 *        body: { key, label?, aliases?, dimension?, to_base? }
 *        Updates an existing unit (built-in or custom). Editing built-ins is allowed —
 *        the toBase / aliases / label can be corrected by an admin. The key is immutable.
 * DELETE /api/units?key=K           admin
 *        Removes a unit. Built-in units are protected unless ?force=1 is passed,
 *        in which case we re-seed on next startup anyway (idempotent seeding).
 *
 * After every write, the in-memory UNIT_REGISTRY is reloaded from DB so subsequent
 * convert() calls reflect the change immediately — no server restart needed.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try { const arr = JSON.parse(t); return Array.isArray(arr) ? arr.map(String) : []; } catch { /* fall through */ }
    }
    return t.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function loadAllAndApply(db: ReturnType<typeof getDb>) {
  const rows = db.prepare('SELECT key, label, aliases, dimension, to_base FROM units ORDER BY dimension, key').all() as any[];
  applyRegistryRows(rows);
  return rows;
}

export async function GET() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, label, aliases, dimension, to_base, is_builtin, updated_at FROM units ORDER BY dimension, key').all() as any[];
    // Parse aliases JSON for nicer client consumption
    const out = rows.map(r => ({ ...r, aliases: (() => { try { return JSON.parse(r.aliases); } catch { return []; } })() }));
    return Response.json({ units: out });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const b = await req.json();
    const key = String(b.key || '').trim();
    const label = String(b.label || key).trim();
    const dimension = String(b.dimension || '').toLowerCase() as Dimension;
    const toBase = Number(b.to_base);
    if (!key) return Response.json({ error: 'key required' }, { status: 400 });
    if (!['volume', 'weight', 'count'].includes(dimension)) {
      return Response.json({ error: 'dimension must be volume / weight / count' }, { status: 400 });
    }
    if (!Number.isFinite(toBase) || toBase <= 0) {
      return Response.json({ error: 'to_base must be a positive number' }, { status: 400 });
    }
    const aliases = normalizeAliases(b.aliases);

    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO units (key, label, aliases, dimension, to_base, is_builtin, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
      `).run(key, label, JSON.stringify(aliases), dimension, toBase);
    } catch (e: any) {
      if (/UNIQUE/i.test(e.message)) {
        return Response.json({ error: `Unit "${key}" already exists. Use PUT to edit it.` }, { status: 409 });
      }
      throw e;
    }
    loadAllAndApply(db);
    return Response.json({ success: true, key }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const b = await req.json();
    const key = String(b.key || '').trim();
    if (!key) return Response.json({ error: 'key required' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare('SELECT * FROM units WHERE key = ?').get(key) as any;
    if (!existing) return Response.json({ error: `Unit "${key}" not found` }, { status: 404 });

    const label     = b.label     != null ? String(b.label).trim() : existing.label;
    const dimension = b.dimension != null ? String(b.dimension).toLowerCase() : existing.dimension;
    const toBase    = b.to_base   != null ? Number(b.to_base) : existing.to_base;
    if (!['volume', 'weight', 'count'].includes(dimension)) {
      return Response.json({ error: 'dimension must be volume / weight / count' }, { status: 400 });
    }
    if (!Number.isFinite(toBase) || toBase <= 0) {
      return Response.json({ error: 'to_base must be a positive number' }, { status: 400 });
    }
    const aliases = b.aliases !== undefined ? normalizeAliases(b.aliases)
                                              : (() => { try { return JSON.parse(existing.aliases); } catch { return []; } })();

    db.prepare(`
      UPDATE units SET label = ?, aliases = ?, dimension = ?, to_base = ?, updated_at = datetime('now')
      WHERE key = ?
    `).run(label, JSON.stringify(aliases), dimension, toBase, key);

    loadAllAndApply(db);
    return Response.json({ success: true, key });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const url = new URL(req.url);
    const key = url.searchParams.get('key') || '';
    const force = url.searchParams.get('force') === '1';
    if (!key) return Response.json({ error: 'key required' }, { status: 400 });
    const db = getDb();
    const existing = db.prepare('SELECT * FROM units WHERE key = ?').get(key) as any;
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });
    if (existing.is_builtin && !force) {
      return Response.json({ error: `"${key}" is a built-in unit. Pass ?force=1 to delete (it will be re-seeded on next startup).` }, { status: 400 });
    }
    db.prepare('DELETE FROM units WHERE key = ?').run(key);
    loadAllAndApply(db);
    return Response.json({ success: true, key });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
