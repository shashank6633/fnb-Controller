/**
 * Guest Quiz helpers — shared by the PUBLIC /api/crm/guest-quiz/* routes.
 *
 * These routes are deliberately session-less (job candidates / trial staff get
 * a shareable link, no login). All correctness data (correct_index,
 * explanation) lives ONLY in the server-side questions_json snapshot on
 * crm_guest_quiz_sessions — questions sent to the browser are stripped.
 *
 * Ported from akan-crm: services/question_bank.get_quiz_from_bank (role-weighted
 * category distribution + per-question option shuffle) and
 * routes/guest_quiz.generate_guest_report (grade / category breakdown).
 */
import { getDb } from '@/lib/db';

// ── Types ────────────────────────────────────────────────────────────────

/** Full server-side snapshot question (NEVER send to the browser as-is). */
export interface SnapshotQuestion {
  id: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  category: string;
  subcategory: string | null;
  difficulty: string;
}

/** What the browser is allowed to see. */
export interface StrippedQuestion {
  question_number: number;
  question: string;
  options: string[];
  category: string;
  difficulty: string;
}

export interface GuestReport {
  score: number;
  correct: number;
  total: number;
  percentage: number;
  passed: boolean;
  pass_threshold: number;
  grade: string;
  message: string;
  category_breakdown: Record<string, { correct: number; total: number; percentage: number }>;
  weak_areas: string[];
}

export interface QuizLinkRow {
  id: string;
  link_code: string;
  title: string;
  difficulty: string;
  question_count: number;
  pass_threshold: number;
  max_attempts: number;
  attempt_count: number;
  expires_at: string | null;
  is_active: number;
  created_by: string | null;
  created_at: string;
}

export interface GuestSessionRow {
  id: string;
  link_id: string;
  guest_name: string;
  guest_mobile: string;
  guest_position: string;
  questions_json: string;
  total_questions: number;
  score: number;
  status: string; // active | completed | cheated
  time_taken_seconds: number | null;
  started_at: string;
  completed_at: string | null;
}

// ── Link helpers ─────────────────────────────────────────────────────────

export function getLinkByCode(linkCode: string): QuizLinkRow | undefined {
  const db = getDb();
  return db
    .prepare('SELECT * FROM crm_quiz_links WHERE link_code = ?')
    .get(linkCode) as QuizLinkRow | undefined;
}

/** Mirrors the Flask gate order: missing → inactive → expired → maxed. */
export function validateLink(link: QuizLinkRow | undefined): string | null {
  if (!link) return 'Quiz link not found.';
  if (!link.is_active) return 'This quiz link has been deactivated.';
  if (link.expires_at) {
    const expiry = new Date(link.expires_at);
    if (!isNaN(expiry.getTime()) && new Date() > expiry) {
      return 'This quiz link has expired.';
    }
  }
  if (link.max_attempts && link.attempt_count >= link.max_attempts) {
    return 'This quiz has reached the maximum number of attempts.';
  }
  return null;
}

// ── Question bank (role-weighted, ported from get_quiz_from_bank) ────────

const STAFF_POSITIONS = new Set(['Captain', 'Waiter', 'Chef', 'Bartender', 'Host']);

// Staff-facing roles: heavy on service, menu, upselling — no CRM.
const STAFF_DISTRIBUTION: Record<string, number> = {
  'Menu Knowledge': 3,
  'Service Skills': 2,
  'Guest Handling': 2,
  Upselling: 2,
  'Service SOP': 1,
};

// Everyone else (Manager / Other): balanced across all categories.
const GENERAL_DISTRIBUTION: Record<string, number> = {
  'Menu Knowledge': 2,
  'Service Skills': 2,
  Communication: 1,
  'Guest Handling': 1,
  Upselling: 2,
  'Service SOP': 1,
  'CRM Actions': 1,
};

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Scale a base 10-question distribution to `count` questions (Flask port). */
function scaleDistribution(base: Record<string, number>, count: number): Record<string, number> {
  const dist: Record<string, number> = { ...base };
  const totalParts = Object.values(dist).reduce((a, b) => a + b, 0);
  if (count === totalParts) return dist;

  for (const k of Object.keys(dist)) {
    dist[k] = Math.max(1, Math.round((dist[k] * count) / totalParts));
  }
  let sum = Object.values(dist).reduce((a, b) => a + b, 0);
  // Trim from the biggest buckets first
  while (sum > count) {
    const keys = Object.keys(dist).sort((a, b) => dist[b] - dist[a]);
    let trimmed = false;
    for (const k of keys) {
      if (dist[k] > 1) {
        dist[k] -= 1;
        sum -= 1;
        trimmed = true;
        break;
      }
    }
    if (!trimmed) break; // every bucket at 1 and still over → backfill slice handles it
  }
  // Grow the smallest buckets first
  while (sum < count) {
    const keys = Object.keys(dist).sort((a, b) => dist[a] - dist[b]);
    dist[keys[0]] += 1;
    sum += 1;
  }
  return dist;
}

interface BankRow {
  id: string;
  category: string;
  subcategory: string | null;
  difficulty: string;
  question: string;
  options_json: string;
  correct_index: number;
  explanation: string | null;
}

function toSnapshot(row: BankRow): SnapshotQuestion | null {
  let options: string[];
  try {
    options = JSON.parse(row.options_json);
  } catch {
    return null;
  }
  if (!Array.isArray(options) || options.length < 2) return null;
  if (row.correct_index < 0 || row.correct_index >= options.length) return null;

  // Shuffle options so the correct answer isn't always in the same slot.
  const correctAnswer = options[row.correct_index];
  const indices = shuffleInPlace(options.map((_, i) => i));
  const shuffled = indices.map((i) => options[i]);

  return {
    id: row.id,
    question: row.question,
    options: shuffled,
    correct_index: shuffled.indexOf(correctAnswer),
    explanation: row.explanation || '',
    category: row.category,
    subcategory: row.subcategory,
    difficulty: row.difficulty,
  };
}

/**
 * Pull `count` questions from crm_question_bank, weighted by position.
 * Captain/Waiter/Chef/Bartender/Host → staff distribution; else general.
 * difficulty 'random' (or empty) → no difficulty filter.
 */
export function buildGuestQuiz(count: number, difficulty: string, position: string): SnapshotQuestion[] {
  const db = getDb();
  const base = STAFF_POSITIONS.has(position) ? STAFF_DISTRIBUTION : GENERAL_DISTRIBUTION;
  const dist = scaleDistribution(base, count);
  const useDifficulty = difficulty && difficulty !== 'random';

  const selected: SnapshotQuestion[] = [];
  const pickedIds = new Set<string>();

  for (const [category, qty] of Object.entries(dist)) {
    let sql = 'SELECT * FROM crm_question_bank WHERE is_active = 1 AND category = ?';
    const params: unknown[] = [category];
    if (useDifficulty) {
      sql += ' AND difficulty = ?';
      params.push(difficulty);
    }
    sql += ' ORDER BY RANDOM() LIMIT ?';
    params.push(qty);

    let rows = db.prepare(sql).all(...params) as BankRow[];

    // Not enough at this difficulty → relax the difficulty filter (Flask fallback).
    if (rows.length < qty && useDifficulty) {
      rows = db
        .prepare('SELECT * FROM crm_question_bank WHERE is_active = 1 AND category = ? ORDER BY RANDOM() LIMIT ?')
        .all(category, qty) as BankRow[];
    }

    for (const row of rows) {
      if (pickedIds.has(row.id)) continue;
      const q = toSnapshot(row);
      if (q) {
        selected.push(q);
        pickedIds.add(row.id);
      }
    }
  }

  // Backfill from the whole bank if category quotas under-delivered.
  if (selected.length < count) {
    const need = count - selected.length;
    const excluded = pickedIds.size
      ? `AND id NOT IN (${Array.from(pickedIds).map(() => '?').join(',')})`
      : '';
    const rows = db
      .prepare(`SELECT * FROM crm_question_bank WHERE is_active = 1 ${excluded} ORDER BY RANDOM() LIMIT ?`)
      .all(...Array.from(pickedIds), need) as BankRow[];
    for (const row of rows) {
      const q = toSnapshot(row);
      if (q) {
        selected.push(q);
        pickedIds.add(row.id);
      }
    }
  }

  shuffleInPlace(selected);
  return selected.slice(0, count);
}

// ── Browser-facing shape ─────────────────────────────────────────────────

/** Strip correct_index / explanation / id before sending to the browser. */
export function stripQuestion(q: SnapshotQuestion, questionNumber: number): StrippedQuestion {
  return {
    question_number: questionNumber,
    question: q.question,
    options: q.options,
    category: q.category,
    difficulty: q.difficulty,
  };
}

// ── Report (ported from generate_guest_report) ───────────────────────────

export function gradeFor(percentage: number): string {
  if (percentage >= 90) return 'A+';
  if (percentage >= 80) return 'A';
  if (percentage >= 70) return 'B+';
  if (percentage >= 60) return 'B';
  if (percentage >= 50) return 'C';
  return 'D';
}

function messageFor(percentage: number): string {
  if (percentage >= 90) return 'Outstanding! You know Akan inside out!';
  if (percentage >= 70) return 'Great job! Keep it up!';
  if (percentage >= 50) return 'Good effort! Review the areas you missed.';
  return 'Keep practicing! Review and try again.';
}

interface ResponseRow {
  question_number: number;
  is_correct: number;
}

/**
 * Build the final report card. Category comes from the questions_json snapshot
 * (crm_guest_quiz_responses has no category column) joined by question_number.
 */
export function buildGuestReport(
  session: GuestSessionRow,
  link: QuizLinkRow,
): GuestReport {
  const db = getDb();
  const responses = db
    .prepare(
      'SELECT question_number, is_correct FROM crm_guest_quiz_responses WHERE guest_session_id = ? ORDER BY question_number',
    )
    .all(session.id) as ResponseRow[];

  let questions: SnapshotQuestion[] = [];
  try {
    questions = JSON.parse(session.questions_json);
  } catch {
    questions = [];
  }

  const total = session.total_questions || questions.length;
  const correct = responses.reduce((n, r) => n + (r.is_correct ? 1 : 0), 0);
  const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;

  const category_breakdown: Record<string, { correct: number; total: number; percentage: number }> = {};
  for (const r of responses) {
    const q = questions[r.question_number - 1];
    const cat = q?.category || 'General';
    if (!category_breakdown[cat]) category_breakdown[cat] = { correct: 0, total: 0, percentage: 0 };
    category_breakdown[cat].total += 1;
    if (r.is_correct) category_breakdown[cat].correct += 1;
  }
  const weak_areas: string[] = [];
  for (const [cat, data] of Object.entries(category_breakdown)) {
    data.percentage = data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0;
    if (data.percentage < 50) weak_areas.push(cat);
  }

  return {
    score: correct,
    correct,
    total,
    percentage,
    passed: percentage >= link.pass_threshold,
    pass_threshold: link.pass_threshold,
    grade: gradeFor(percentage),
    message: messageFor(percentage),
    category_breakdown,
    weak_areas,
  };
}

/** Seconds elapsed since the session's started_at (SQLite UTC datetime). */
export function elapsedSeconds(sessionId: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER) AS secs
       FROM crm_guest_quiz_sessions WHERE id = ?`,
    )
    .get(sessionId) as { secs: number | null } | undefined;
  if (!row || row.secs == null || row.secs < 0) return null;
  return row.secs;
}
