/**
 * crm-reports.ts — quiz + training report builders for the CRM
 * Quiz/Training vertical (port of generate_quiz_report in
 * akan-crm/routes/quiz.py and generate_report in akan-crm/routes/training.py,
 * adapted to the crm_* schema).
 *
 * Grading:
 *  - Quiz  : A+ >= 90%, A >= 80%, B >= 70%, C >= 60%, else D
 *  - Training (avg of 10-point scores): A+ >= 9, A >= 8, B+ >= 7, B >= 6, C >= 5, else D
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDb } from '@/lib/db';

export interface QuizCategoryStat { correct: number; total: number; percentage: number; }

export interface QuizReport {
  score: number;
  total: number;
  percentage: number;
  grade: string;
  message: string;
  category_breakdown: Record<string, QuizCategoryStat>;
  weak_areas: string[];
}

/**
 * Build a quiz report from the questions snapshot (carries category) and the
 * saved responses (crm_quiz_responses has no category column, so the snapshot
 * is the source of truth for categorisation).
 */
export function buildQuizReport(
  questions: any[],
  responses: Array<{ question_number: number; is_correct: number }>
): QuizReport {
  const total = questions.length;
  const byNumber = new Map<number, boolean>();
  for (const r of responses) byNumber.set(Number(r.question_number), !!r.is_correct);

  let score = 0;
  const cats: Record<string, { correct: number; total: number }> = {};
  questions.forEach((q, i) => {
    const cat = (q && q.category) || 'General';
    if (!cats[cat]) cats[cat] = { correct: 0, total: 0 };
    cats[cat].total += 1;
    if (byNumber.get(i + 1)) {
      cats[cat].correct += 1;
      score += 1;
    }
  });

  const percentage = total > 0 ? Math.round((score / total) * 100) : 0;

  let grade: string;
  if (percentage >= 90) grade = 'A+';
  else if (percentage >= 80) grade = 'A';
  else if (percentage >= 70) grade = 'B';
  else if (percentage >= 60) grade = 'C';
  else grade = 'D';

  const category_breakdown: Record<string, QuizCategoryStat> = {};
  const weak_areas: string[] = [];
  for (const [cat, data] of Object.entries(cats)) {
    const pct = data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0;
    category_breakdown[cat] = { correct: data.correct, total: data.total, percentage: pct };
    if (pct < 50) weak_areas.push(cat);
  }

  let message: string;
  if (percentage >= 90) message = 'Outstanding! You know Akan inside out.';
  else if (percentage >= 70) message = 'Great job! Keep it up, you are doing well.';
  else if (percentage >= 50) message = 'Good effort. Review the areas you missed and try again.';
  else message = 'Keep practicing. Review the knowledge base and try again tomorrow.';

  return { score, total, percentage, grade, message, category_breakdown, weak_areas };
}

export interface TrainingCategoryStat { total: number; count: number; average: number; }

export interface TrainingReport {
  session_id: string;
  user_id: string;
  difficulty: string;
  category: string;
  language: string;
  total_score: number;
  max_score: number;
  average_score: number;
  percentage: number;
  grade: string;
  message: string;
  questions_answered: number;
  category_scores: Record<string, TrainingCategoryStat>;
  weak_areas: string[];
  responses: any[];
}

/**
 * Build the training report for a session from crm_training_responses.
 * The per-response category is read from the stored feedback JSON blob
 * (crm_training_responses has no category column). Returns null when the
 * session doesn't exist. Caller checks user_id for ownership.
 */
export function generateTrainingReport(trainingSessionId: string): TrainingReport | null {
  const db = getDb();
  const session = db.prepare('SELECT * FROM crm_training_sessions WHERE id = ?').get(trainingSessionId) as any;
  if (!session) return null;

  const rows = db.prepare(`
    SELECT * FROM crm_training_responses
    WHERE training_session_id = ? ORDER BY question_number
  `).all(trainingSessionId) as any[];

  const responses = rows.map((r) => {
    let category = 'general';
    let feedback: any = null;
    try {
      feedback = JSON.parse(r.feedback || 'null');
      if (feedback && typeof feedback === 'object' && feedback.category) {
        category = String(feedback.category) || 'general';
      }
    } catch { /* keep 'general' */ }
    return {
      question_number: r.question_number,
      question: r.question,
      user_response: r.user_response,
      score: Number(r.score) || 0,
      ideal_answer: r.ideal_answer || '',
      category: category || 'general',
      feedback,
      created_at: r.created_at,
    };
  });

  const totalScore = responses.reduce((s, r) => s + r.score, 0);
  const numQuestions = responses.length;
  const average = numQuestions > 0 ? Math.round((totalScore / numQuestions) * 10) / 10 : 0;

  // Category-wise scores
  const category_scores: Record<string, TrainingCategoryStat> = {};
  for (const r of responses) {
    const cat = r.category || 'general';
    if (!category_scores[cat]) category_scores[cat] = { total: 0, count: 0, average: 0 };
    category_scores[cat].total += r.score;
    category_scores[cat].count += 1;
  }
  for (const cat of Object.keys(category_scores)) {
    const c = category_scores[cat];
    c.average = c.count > 0 ? Math.round((c.total / c.count) * 10) / 10 : 0;
  }

  // Weak areas: categories with average below 6
  const weak_areas = Object.entries(category_scores)
    .filter(([, d]) => d.average < 6)
    .map(([cat]) => cat);

  let grade: string;
  let message: string;
  if (average >= 9) { grade = 'A+'; message = 'Outstanding! You are a front desk star!'; }
  else if (average >= 8) { grade = 'A'; message = 'Excellent! You handle calls like a pro!'; }
  else if (average >= 7) { grade = 'B+'; message = 'Very good! Just a few areas to polish.'; }
  else if (average >= 6) { grade = 'B'; message = 'Good job! Keep practicing to improve further.'; }
  else if (average >= 5) { grade = 'C'; message = 'Average. Review the call scripts and practice more.'; }
  else { grade = 'D'; message = 'Needs improvement. Please review the knowledge base and call scripts.'; }

  return {
    session_id: trainingSessionId,
    user_id: session.user_id,
    difficulty: session.difficulty,
    category: session.category,
    language: session.language,
    total_score: totalScore,
    max_score: numQuestions * 10,
    average_score: average,
    percentage: numQuestions > 0 ? Math.round((totalScore / (numQuestions * 10)) * 100) : 0,
    grade,
    message,
    questions_answered: numQuestions,
    category_scores,
    weak_areas,
    responses,
  };
}
