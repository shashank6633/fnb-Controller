/**
 * CRM Admin — Question Bank stats + reseed (ADMIN only).
 *
 * GET  /api/crm/admin/question-bank
 *   → { total, active, by_category: [{ category, difficulty, count, active }] }
 *
 * POST /api/crm/admin/question-bank  { reseed: true }
 *   Re-reads src/data/crm/question-bank.json.
 *   - Table empty  → inserts everything.
 *   - Table has rows → inserts ONLY questions whose exact question text is not
 *     already present (top-up). NEVER wipes or overwrites existing rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import { requireRole } from '@/lib/auth';
import { getDb, generateId } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const totals = db.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active FROM crm_question_bank'
  ).get() as any;
  const byCategory = db.prepare(`
    SELECT category, difficulty, COUNT(*) AS count, COALESCE(SUM(is_active), 0) AS active
    FROM crm_question_bank
    GROUP BY category, difficulty
    ORDER BY category, CASE difficulty WHEN 'easy' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
  `).all() as any[];

  return Response.json({ total: totals.total, active: totals.active, by_category: byCategory });
}

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any = {};
  try { body = await req.json(); } catch { /* tolerate empty body */ }
  if (body?.reseed !== true) {
    return Response.json({ error: 'Pass { "reseed": true } to reseed the question bank' }, { status: 400 });
  }

  const file = path.join(process.cwd(), 'src', 'data', 'crm', 'question-bank.json');
  if (!fs.existsSync(file)) {
    return Response.json({ error: 'question-bank.json not found in src/data/crm' }, { status: 500 });
  }

  let rows: any[];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('file is not a JSON array');
  } catch (e: any) {
    return Response.json({ error: `Could not parse question-bank.json: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  const db = getDb();
  const existing = new Set(
    (db.prepare('SELECT question FROM crm_question_bank').all() as any[]).map(r => r.question as string)
  );

  const ins = db.prepare(`
    INSERT INTO crm_question_bank (id, category, subcategory, difficulty, question, options_json, correct_index, explanation, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  let added = 0;
  let skipped = 0;
  const tx = db.transaction((all: any[]) => {
    for (const r of all) {
      if (!r?.question || typeof r.question !== 'string') { skipped++; continue; }
      if (existing.has(r.question)) { skipped++; continue; }
      ins.run(
        generateId(),
        r.category || '',
        r.subcategory || '',
        r.difficulty || 'medium',
        r.question,
        r.options_json || '[]',
        r.correct_index ?? 0,
        r.explanation || '',
      );
      existing.add(r.question);
      added++;
    }
  });
  tx(rows);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM crm_question_bank').get() as any).n;
  return Response.json({
    message: added > 0
      ? `Added ${added} new question${added === 1 ? '' : 's'} (${skipped} already present)`
      : `Question bank already up to date (${skipped} questions matched)`,
    added, skipped, total,
  });
}
