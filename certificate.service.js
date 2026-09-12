import crypto from 'crypto';
import { pool } from '../db.js';

function generateCertificateCode() {
  // e.g. MLMS-8F3A9C2B — short, unambiguous, easy to read aloud for verification
  return `MLMS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Computes a user's completion percentage for a course. Returns null if the
 * course has zero lessons (nothing to complete, so nothing to certify).
 */
export async function getCourseCompletion(userId, courseId) {
  const { rows } = await pool.query(
    `SELECT
        COUNT(DISTINCT l.id)::int AS total_lessons,
        COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.completed)::int AS completed_lessons
     FROM courses c
     JOIN modules m ON m.course_id = c.id
     JOIN lessons l ON l.module_id = m.id
     LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $1
     WHERE c.id = $2`,
    [userId, courseId],
  );
  const { total_lessons, completed_lessons } = rows[0] || { total_lessons: 0, completed_lessons: 0 };
  if (total_lessons === 0) return { total_lessons: 0, completed_lessons: 0, percent: 0 };
  return {
    total_lessons,
    completed_lessons,
    percent: Math.round((completed_lessons / total_lessons) * 100),
  };
}

/**
 * If the user has completed 100% of a course's lessons and doesn't already
 * hold a certificate for it, issues one. Idempotent — safe to call after
 * every lesson/quiz/assignment completion.
 */
export async function issueCertificateIfComplete(userId, courseId) {
  const completion = await getCourseCompletion(userId, courseId);
  if (completion.percent < 100 || completion.total_lessons === 0) return null;

  const existing = await pool.query(
    'SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2',
    [userId, courseId],
  );
  if (existing.rows[0]) return existing.rows[0];

  // Retry once on the (extremely unlikely) event of a certificate_code collision.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO certificates (user_id, course_id, certificate_code)
         VALUES ($1, $2, $3) RETURNING *`,
        [userId, courseId, generateCertificateCode()],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505' && attempt < 2) continue; // unique_violation on certificate_code — retry
      if (err.code === '23505') {
        // Someone else's concurrent request won the race — fetch what they created.
        const { rows } = await pool.query(
          'SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2',
          [userId, courseId],
        );
        return rows[0] || null;
      }
      throw err;
    }
  }
  return null;
}
