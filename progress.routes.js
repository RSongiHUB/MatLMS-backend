import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { getCourseCompletion, issueCertificateIfComplete } from '../services/certificate.service.js';

const router = Router();

/**
 * Resolves the course_id a lesson belongs to, via its module.
 */
async function courseIdForLesson(lessonId) {
  const { rows } = await pool.query(
    `SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`,
    [lessonId],
  );
  return rows[0] ? rows[0].course_id : null;
}

// -----------------------------------------------------------------------
// POST /api/progress/lessons/:lessonId/complete
// Marks a video/text lesson complete directly. (Quiz lessons are marked
// complete by quiz.routes.js on a passing attempt; assignment lessons by
// assignment.routes.js on submission — both call the same upsert below,
// so this endpoint is really for the simple "Mark as complete" button on
// video/text lessons.)
// -----------------------------------------------------------------------
router.post('/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  const { lessonId } = req.params;
  try {
    const lessonResult = await pool.query('SELECT * FROM lessons WHERE id = $1', [lessonId]);
    const lesson = lessonResult.rows[0];
    if (!lesson) return res.status(404).json({ status: 'error', message: 'Lesson not found' });

    const courseId = await courseIdForLesson(lessonId);

    const enrolled = await pool.query(
      'SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user.id, courseId],
    );
    if (enrolled.rows.length === 0) {
      return res.status(403).json({ status: 'error', message: 'You must be enrolled in this course first' });
    }

    await pool.query(
      `INSERT INTO progress (user_id, lesson_id, completed, completed_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (user_id, lesson_id)
       DO UPDATE SET completed = true, completed_at = now()`,
      [req.user.id, lessonId],
    );

    const certificate = await issueCertificateIfComplete(req.user.id, courseId);
    const completion = await getCourseCompletion(req.user.id, courseId);

    res.json({ status: 'ok', completion, certificate_issued: !!certificate });
  } catch (err) {
    console.error('[progress] complete error', err);
    res.status(500).json({ status: 'error', message: 'Could not update progress' });
  }
});

// -----------------------------------------------------------------------
// GET /api/progress/courses/:courseId — current user's completion for one course
// -----------------------------------------------------------------------
router.get('/courses/:courseId', requireAuth, async (req, res) => {
  try {
    const completion = await getCourseCompletion(req.user.id, req.params.courseId);
    const { rows } = await pool.query(
      `SELECT l.id AS lesson_id, COALESCE(p.completed, false) AS completed, p.completed_at
       FROM lessons l
       JOIN modules m ON m.id = l.module_id
       LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $1
       WHERE m.course_id = $2
       ORDER BY m.sort_order, l.sort_order`,
      [req.user.id, req.params.courseId],
    );
    res.json({ status: 'ok', ...completion, lessons: rows });
  } catch (err) {
    console.error('[progress] course progress error', err);
    res.status(500).json({ status: 'error', message: 'Could not load progress' });
  }
});

// -----------------------------------------------------------------------
// GET /api/progress/me — completion summary across every enrolled course
// -----------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows: enrolledCourses } = await pool.query(
      'SELECT course_id FROM enrollments WHERE user_id = $1',
      [req.user.id],
    );
    const summaries = await Promise.all(
      enrolledCourses.map(async ({ course_id }) => ({
        course_id,
        ...(await getCourseCompletion(req.user.id, course_id)),
      })),
    );
    res.json({ status: 'ok', courses: summaries });
  } catch (err) {
    console.error('[progress] me error', err);
    res.status(500).json({ status: 'error', message: 'Could not load progress summary' });
  }
});

export default router;
