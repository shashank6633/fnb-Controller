/**
 * crm-question-bank.ts — faithful port of get_quiz_from_bank +
 * record_seen_questions from akan-crm/services/question_bank.py
 * (lines 2073–2213), adapted to better-sqlite3 + the crm_* tables.
 *
 * Role mapping note: the Flask 'gre' role is gone in this app. Callers pass
 * role = 'staff' for tier staff, and 'gre' (or 'manager'/'admin') for
 * everything else — the distributions below are byte-faithful to Python.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb, generateId } from '@/lib/db';

export interface BankQuestion {
  id: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  category: string;
  subcategory: string;
  difficulty: string;
}

/** The 7 bank categories (as seeded from the Flask export). */
export const BANK_CATEGORIES = [
  'Menu Knowledge',
  'Service Skills',
  'Communication',
  'Guest Handling',
  'Upselling',
  'Service SOP',
  'CRM Actions',
] as const;

const STAFF_ROLES = new Set(['Captain', 'Waiter', 'Chef', 'Bartender', 'Host', 'Other', 'staff']);

/** Fisher–Yates in-place shuffle (returns the same array). */
function shuffleInPlace<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Fetch a balanced quiz from the question bank for a user.
 * Distribution varies by role:
 *  - Staff: service/menu/upselling heavy — NO CRM Actions
 *  - GRE/Manager/Admin: all categories including CRM Actions
 * Avoids the user's last-100 seen questions; falls back to repeats when the
 * unseen pool for a category is too small. Options are shuffled per question
 * and correct_index re-derived.
 */
export function getQuizFromBank(
  userId: string,
  count = 10,
  difficulty: string | null = null,
  role: string | null = null
): BankQuestion[] {
  const db = getDb();

  // Role-based distribution plans (exact port of the Python weights)
  let distribution: Record<string, number>;
  if (role && STAFF_ROLES.has(role)) {
    // Staff: heavy on service, menu, upselling — no CRM
    distribution = {
      'Menu Knowledge': 3,
      'Service Skills': 2,
      'Guest Handling': 2,
      'Upselling': 2,
      'Service SOP': 1,
    };
  } else if (role && ['gre', 'manager', 'admin'].includes(role.toLowerCase())) {
    // GRE / Manager: all categories including CRM
    distribution = {
      'Menu Knowledge': 1,
      'Service Skills': 2,
      'Communication': 1,
      'Guest Handling': 1,
      'Upselling': 1,
      'Service SOP': 2,
      'CRM Actions': 2,
    };
  } else {
    // Default: balanced across all
    distribution = {
      'Menu Knowledge': 2,
      'Service Skills': 2,
      'Communication': 1,
      'Guest Handling': 1,
      'Upselling': 2,
      'Service SOP': 1,
      'CRM Actions': 1,
    };
  }

  // Adjust if count != 10 (proportional scale, then trim/pad to exact count)
  if (count !== 10) {
    const totalParts = Object.values(distribution).reduce((s, v) => s + v, 0);
    const scaled: Record<string, number> = {};
    for (const [k, v] of Object.entries(distribution)) {
      scaled[k] = Math.max(1, Math.round((v * count) / totalParts));
    }
    distribution = scaled;
    const sum = () => Object.values(distribution).reduce((s, v) => s + v, 0);
    let guard = 200;
    while (sum() > count && guard-- > 0) {
      const keys = Object.keys(distribution).sort((a, b) => distribution[b] - distribution[a]);
      const k = keys.find((key) => distribution[key] > 1);
      if (k) {
        distribution[k] -= 1;
      } else {
        // Every category is at 1 but we're still over count (count < number of
        // categories): drop the smallest — Python would spin forever here.
        delete distribution[keys[keys.length - 1]];
      }
    }
    guard = 200;
    while (sum() < count && guard-- > 0) {
      const keys = Object.keys(distribution).sort((a, b) => distribution[a] - distribution[b]);
      distribution[keys[0]] += 1;
    }
  }

  // Recently seen question IDs (last 100 seen by this user)
  const seenRows = db.prepare(`
    SELECT question_id FROM crm_user_seen_questions
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(userId) as { question_id: string }[];
  const seenIds = [...new Set(seenRows.map((r) => r.question_id))];

  const selected: BankQuestion[] = [];

  for (const [category, qty] of Object.entries(distribution)) {
    // Build query with optional difficulty filter + seen-exclusion
    let query = 'SELECT * FROM crm_question_bank WHERE category = ? AND is_active = 1';
    const params: any[] = [category];

    if (difficulty && difficulty !== 'random') {
      query += ' AND difficulty = ?';
      params.push(difficulty);
    }

    if (seenIds.length > 0) {
      query += ` AND id NOT IN (${seenIds.map(() => '?').join(',')})`;
      params.push(...seenIds);
    }

    query += ' ORDER BY RANDOM() LIMIT ?';
    params.push(qty);

    let rows = db.prepare(query).all(...params) as any[];

    // If not enough unseen questions, allow repeats
    if (rows.length < qty) {
      let fq = 'SELECT * FROM crm_question_bank WHERE category = ? AND is_active = 1';
      const fp: any[] = [category];
      if (difficulty && difficulty !== 'random') {
        fq += ' AND difficulty = ?';
        fp.push(difficulty);
      }
      fq += ' ORDER BY RANDOM() LIMIT ?';
      fp.push(qty);
      rows = db.prepare(fq).all(...fp) as any[];
    }

    for (const row of rows) {
      let options: string[] = [];
      try { options = JSON.parse(row.options_json || '[]'); } catch { options = []; }
      if (!Array.isArray(options) || options.length === 0) continue;

      // Shuffle options so the correct answer isn't always at the same index
      const correctAnswer = options[row.correct_index];
      const shuffled = shuffleInPlace([...options]);
      const newCorrectIndex = shuffled.indexOf(correctAnswer);

      selected.push({
        id: row.id,
        question: row.question,
        options: shuffled,
        correct_index: newCorrectIndex,
        explanation: row.explanation || '',
        category: row.category,
        subcategory: row.subcategory || '',
        difficulty: row.difficulty,
      });
    }
  }

  // Shuffle the final set
  shuffleInPlace(selected);

  return selected;
}

/**
 * Record which questions a user has seen for future deduplication.
 * `questions` is the quiz snapshot (only entries carrying a bank `id` are
 * recorded — AI-generated questions have no id and are skipped, as in Python).
 * `correctness[i]` pairs with questions[i] (1/0/true/false or null if unknown).
 */
export function recordSeenQuestions(
  userId: string,
  questions: Array<{ id?: string | null } & Record<string, any>>,
  correctness: Array<number | boolean | null | undefined> = []
): void {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO crm_user_seen_questions (id, user_id, question_id, was_correct)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    questions.forEach((q, i) => {
      if (q && q.id) {
        const wc = i < correctness.length ? correctness[i] : null;
        ins.run(generateId(), userId, String(q.id), wc == null ? null : (wc ? 1 : 0));
      }
    });
  });
  tx();
}

/** Public-safe view of a quiz question: no correct_index / explanation / bank id. */
export function stripQuizQuestion(q: any): { question: string; options: string[]; category: string; difficulty: string | null } {
  return {
    question: q?.question ?? '',
    options: Array.isArray(q?.options) ? q.options : [],
    category: q?.category || 'General',
    difficulty: q?.difficulty ?? null,
  };
}
