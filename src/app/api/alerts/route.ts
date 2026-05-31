import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();

    const alerts = db.prepare(`
      SELECT
        id as material_id,
        name as material_name,
        current_stock,
        reorder_level,
        unit,
        ROUND(reorder_level - current_stock, 2) as deficit
      FROM raw_materials
      WHERE reorder_level > 0 AND current_stock < reorder_level
      ORDER BY (reorder_level - current_stock) DESC
    `).all();

    return Response.json({ alerts });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
