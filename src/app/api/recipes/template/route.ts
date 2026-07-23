import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

// Sample recipe rows — bar & kitchen examples
// Format: recipe_name, category, selling_price, ingredient_name, quantity, unit, yield_percent, wastage_percent, notes
const SAMPLE_RECIPES: Array<[string, string, number, string, number, string, number, number, string]> = [
  // ------- LIQUOR POURS (1 Peg = 30ml) -------
  ['Peg - Blenders Pride', 'bar-peg', 120, 'BLENDERS PRIDE (750ML)', 30, 'ml', 100, 0, '1 peg = 30ml'],
  ['Large - Blenders Pride', 'bar-large', 200, 'BLENDERS PRIDE (750ML)', 60, 'ml', 100, 0, '2 pegs = 60ml'],
  ['Patiala - Blenders Pride', 'bar-patiala', 280, 'BLENDERS PRIDE (750ML)', 90, 'ml', 100, 0, '3 pegs = 90ml'],
  ['Peg - Absolut Vodka', 'bar-peg', 180, 'ABSOLUT (750ML)', 30, 'ml', 100, 0, '1 peg = 30ml'],
  ['Large - Absolut Vodka', 'bar-large', 300, 'ABSOLUT (750ML)', 60, 'ml', 100, 0, '2 pegs = 60ml'],
  ['Peg - Bacardi White', 'bar-peg', 130, 'BACARDI CARTA BLANCA 150ML', 30, 'ml', 100, 0, '1 peg = 30ml'],
  ['Large - Bacardi White', 'bar-large', 220, 'BACARDI CARTA BLANCA 150ML', 60, 'ml', 100, 0, '2 pegs = 60ml'],
  ['Peg - Old Monk', 'bar-peg', 100, 'OLD MONK (750ML)', 30, 'ml', 100, 0, '1 peg = 30ml'],
  ['Large - Old Monk', 'bar-large', 180, 'OLD MONK (750ML)', 60, 'ml', 100, 0, '2 pegs = 60ml'],
  ['Patiala - Old Monk', 'bar-patiala', 260, 'OLD MONK (750ML)', 90, 'ml', 100, 0, '3 pegs = 90ml'],

  // ------- COCKTAILS -------
  ['Classic Mojito', 'bar-cocktail', 350, 'BACARDI CARTA BLANCA 150ML', 60, 'ml', 100, 0, 'White rum base'],
  ['Classic Mojito', 'bar-cocktail', 350, 'LEMON', 1, 'pcs', 90, 5, 'Fresh lime juice'],
  ['Classic Mojito', 'bar-cocktail', 350, 'MINT LEAVES', 10, 'g', 95, 5, 'Muddle gently'],
  ['Classic Mojito', 'bar-cocktail', 350, 'SODA 750ML', 100, 'ml', 100, 0, 'Top up'],
  ['Classic Mojito', 'bar-cocktail', 350, 'SUGAR 1KG', 15, 'g', 100, 0, 'Or sugar syrup'],

  ['Long Island Iced Tea', 'bar-cocktail', 550, 'ABSOLUT (750ML)', 15, 'ml', 100, 0, ''],
  ['Long Island Iced Tea', 'bar-cocktail', 550, 'BACARDI CARTA BLANCA 150ML', 15, 'ml', 100, 0, ''],
  ['Long Island Iced Tea', 'bar-cocktail', 550, 'SODA 750ML', 60, 'ml', 100, 0, 'Cola top-up'],
  ['Long Island Iced Tea', 'bar-cocktail', 550, 'LEMON', 1, 'pcs', 90, 5, ''],

  ['Cosmopolitan', 'bar-cocktail', 450, 'ABSOLUT (750ML)', 45, 'ml', 100, 0, ''],
  ['Cosmopolitan', 'bar-cocktail', 450, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Cosmopolitan', 'bar-cocktail', 450, 'CRANBERRY JUICE 1L', 30, 'ml', 100, 0, ''],

  ['Whiskey Sour', 'bar-cocktail', 400, 'BLENDERS PRIDE (750ML)', 60, 'ml', 100, 0, ''],
  ['Whiskey Sour', 'bar-cocktail', 400, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Whiskey Sour', 'bar-cocktail', 400, 'SUGAR 1KG', 15, 'g', 100, 0, ''],

  // ------- MOCKTAILS -------
  ['Virgin Mojito', 'bar-mocktail', 200, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Virgin Mojito', 'bar-mocktail', 200, 'MINT LEAVES', 10, 'g', 95, 5, ''],
  ['Virgin Mojito', 'bar-mocktail', 200, 'SODA 750ML', 150, 'ml', 100, 0, ''],
  ['Virgin Mojito', 'bar-mocktail', 200, 'SUGAR 1KG', 15, 'g', 100, 0, ''],

  ['Fruit Punch', 'bar-mocktail', 220, 'ORANGE JUICE 1L', 80, 'ml', 100, 0, ''],
  ['Fruit Punch', 'bar-mocktail', 220, 'PINEAPPLE JUICE 1L', 60, 'ml', 100, 0, ''],
  ['Fruit Punch', 'bar-mocktail', 220, 'CRANBERRY JUICE 1L', 30, 'ml', 100, 0, ''],
  ['Fruit Punch', 'bar-mocktail', 220, 'LEMON', 1, 'pcs', 90, 5, ''],

  ['Cucumber Cooler', 'bar-mocktail', 180, 'CUCUMBER', 50, 'g', 85, 10, ''],
  ['Cucumber Cooler', 'bar-mocktail', 180, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Cucumber Cooler', 'bar-mocktail', 180, 'MINT LEAVES', 8, 'g', 95, 5, ''],
  ['Cucumber Cooler', 'bar-mocktail', 180, 'SODA 750ML', 150, 'ml', 100, 0, ''],

  // ------- HOUSE SODAS -------
  ['Masala Soda', 'bar-soda', 120, 'SODA 750ML', 200, 'ml', 100, 0, ''],
  ['Masala Soda', 'bar-soda', 120, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Masala Soda', 'bar-soda', 120, 'BLACK SALT 100GM', 2, 'g', 100, 0, ''],
  ['Masala Soda', 'bar-soda', 120, 'CUMIN SEEDS 100GM', 1, 'g', 100, 0, 'Roasted jeera powder'],

  ['Ginger Lime Soda', 'bar-soda', 130, 'SODA 750ML', 200, 'ml', 100, 0, ''],
  ['Ginger Lime Soda', 'bar-soda', 130, 'GINGER', 10, 'g', 85, 10, ''],
  ['Ginger Lime Soda', 'bar-soda', 130, 'LEMON', 1, 'pcs', 90, 5, ''],
  ['Ginger Lime Soda', 'bar-soda', 130, 'SUGAR 1KG', 15, 'g', 100, 0, ''],
];

const HEADERS = [
  'recipe_name',
  'category',
  'selling_price',
  'ingredient_name',
  'quantity',
  'unit',
  'yield_percent',
  'wastage_percent',
  'notes',
];

function csvEscape(val: any): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function GET(request: Request) {
  try {
    // SECURITY: the proxy only checks that a session cookie is PRESENT for GETs —
    // real validation is delegated here (with_materials=true leaks the full
    // materials list to a forged/expired cookie otherwise).
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const format = url.searchParams.get('format') || 'csv';
    const includeMaterials = url.searchParams.get('with_materials') === 'true';

    // Build CSV
    const lines: string[] = [];

    // Header row
    lines.push(HEADERS.map(csvEscape).join(','));

    // Sample recipe rows (instruction comment)
    const sampleRows = SAMPLE_RECIPES;
    for (const row of sampleRows) {
      lines.push(row.map(csvEscape).join(','));
    }

    // Optionally append all available materials as reference (commented lines ignored on import)
    if (includeMaterials) {
      const db = getDb();
      const materials = db.prepare('SELECT name, unit, category FROM raw_materials ORDER BY category, name').all() as any[];
      lines.push('');
      lines.push('# ---- Reference: Available Materials (ignore these rows when importing) ----');
      for (const m of materials) {
        lines.push(`# ${csvEscape(m.name)},${csvEscape(m.category)},,,1,${csvEscape(m.unit)},100,0,`);
      }
    }

    const csv = lines.join('\n');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="recipe_template_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
