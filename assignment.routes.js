import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { checkRole } from '../middleware/role.middleware.js';
import { issueCertificateIfComplete, getCourseCompletion } from '../services/certificate.service.js';

const router = Router();

async function loadAssignmentContext(assignmentId) {
  const { rows } = await pool.query(
    `SELECT a.*, l.id AS lesson_id, m.course_id, c.instructor_id AS course_instructor_id
     FROM assignments a
     JOIN lessons l ON l.id = a.lesson_id
     JOIN modules m ON m.id = l.module_id
     JOIN courses c ON c.id = m.course_id
     WHERE a.id = $1`,
    [assignmentId],
  );
  return rows[0] || null;
}

// -----------------------------------------------------------------------
// GET /api/assignments/lesson/:lessonId — details + my latest submission
// -----------------------------------------------------------------------
router.get('/lesson/:lessonId', requireAuth, async (req, res) => {
  try {
    const assignmentResult = await pool.query('SELECT * FROM assignments WHERE lesson_id = $1', [req.params.lessonId]);
    const assignment = assignmentResult.rows[0];
    if (!assignment) return res.status(404).json({ status: 'error', message: 'No assignment found for this lesson' });

    const submissionResult = await pool.query(
      `SELECT * FROM assignment_submissions WHERE assignment_id = $1 AND user_id = $2
       ORDER BY submitted_at DESC LIMIT 1`,
      [assignment.id, req.user.id],
    );

    res.json({ status: 'ok', assignment, my_submission: submissionResult.rows[0] || null });
  } catch (err) {
    console.error('[assignment] fetch error', err);
    res.status(500).json({ status: 'error', message: 'Could not load assignment' });
  }
});

// -----------------------------------------------------------------------
// POST /api/assignments/:assignmentId/submissions — student submits work
// Submitting marks the lesson complete immediately; instructor grading
// (below) adds a score/feedback afterward without blocking progress.
// -----------------------------------------------------------------------
router.post('/:assignmentId/submissions', requireAuth, async (req, res) => {
  const { assignmentId } = req.params;
  const { submission_text, submission_url } = req.body || {};

  if (!submission_text && !submission_url) {
    return res.status(400).json({ status: 'error', message: 'Provide submission_text and/or submission_url' });
  }

  try {
    const ctx = await loadAssignmentContext(assignmentId);
    if (!ctx) return res.status(404).json({ status: 'error', message: 'Assignment not found' });

    const enrolled = await pool.query(
      'SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user.id, ctx.course_id],
    );
    if (enrolled.rows.length === 0) {
      return res.status(403).json({ status: 'error', message: 'You must be enrolled in this course first' });
    }

    const { rows } = await pool.query(
      `INSERT INTO assignment_submissions (assignment_id, user_id, submission_text, submission_url, status)
       VALUES ($1, $2, $3, $4, 'submitted') RETURNING *`,
      [assignmentId, req.user.id, submission_text || null, submission_url || null],
    );

    await pool.query(
      `INSERT INTO progress (user_id, lesson_id, completed, completed_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET completed = true, completed_at = now()`,
      [req.user.id, ctx.lesson_id],
    );

    const certificate = await issueCertificateIfComplete(req.user.id, ctx.course_id);
    const completion = await getCourseCompletion(req.user.id, ctx.course_id);

    res.status(201).json({ status: 'ok', submission: rows[0], completion, certificate_issued: !!certificate });
  } catch (err) {
    console.error('[assignment] submit error', err);
    res.status(500).json({ status: 'error', message: 'Could not submit assignment' });
  }
});

// -----------------------------------------------------------------------
// GET /api/assignments/:assignmentId/submissions — instructor/admin grading queue
// -----------------------------------------------------------------------
router.get('/:assignmentId/submissions', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    const ctx = await loadAssignmentContext(req.params.assignmentId);
    if (!ctx) return res.status(404).json({ status: 'error', message: 'Assignment not found' });
    if (req.user.role !== 'admin' && ctx.course_instructor_id !== req.user.id) {
      return res.status(403).json({ status: 'error', message: 'You do not own this course' });
    }

    const { rows } = await pool.query(
      `SELECT s.*, u.full_name AS student_name, u.email AS student_email
       FROM assignment_submissions s JOIN users u ON u.id = s.user_id
       WHERE s.assignment_id = $1 ORDER BY s.submitted_at DESC`,
      [req.params.assignmentId],
    );
    res.json({ status: 'ok', submissions: rows });
  } catch (err) {
    console.error('[assignment] submissions list error', err);
    res.status(500).json({ status: 'error', message: 'Could not load submissions' });
  }
});

// -----------------------------------------------------------------------
// PUT /api/assignments/submissions/:submissionId/grade
// -----------------------------------------------------------------------
router.put('/submissions/:submissionId/grade', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  const { score, feedback } = req.body || {};
  if (!Number.isInteger(score) || score < 0) {
    return res.status(400).json({ status: 'error', message: 'score must be a non-negative integer' });
  }

  try {
    const { rows: subRows } = await pool.query(
      `SELECT s.*, a.lesson_id, c.instructor_id AS course_instructor_id
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN lessons l ON l.id = a.lesson_id
       JOIN modules m ON m.id = l.module_id
       JOIN courses c ON c.id = m.course_id
       WHERE s.id = $1`,
      [req.params.submissionId],
    );
    const submission = subRows[0];
    if (!submission) return res.status(404).json({ status: 'error', message: 'Submission not found' });
    if (req.user.role !== 'admin' && submission.course_instructor_id !== req.user.id) {
      return res.status(403).json({ status: 'error', message: 'You do not own this course' });
    }

    const { rows } = await pool.query(
      `UPDATE assignment_submissions
       SET status = 'graded', score = $1, feedback = $2, graded_at = now(), graded_by = $3
       WHERE id = $4 RETURNING *`,
      [score, feedback || null, req.user.id, req.params.submissionId],
    );
    res.json({ status: 'ok', submission: rows[0] });
  } catch (err) {
    console.error('[assignment] grade error', err);
    res.status(500).json({ status: 'error', message: 'Could not grade submission' });
  }
});

export default router;
