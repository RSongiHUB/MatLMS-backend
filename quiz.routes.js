import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { checkRole } from '../middleware/role.middleware.js';
import { issueCertificateIfComplete, getCourseCompletion } from '../services/certificate.service.js';

const router = Router();

async function loadQuizOwnership(quizId, user) {
  const { rows } = await pool.query(
    `SELECT q.*, c.instructor_id AS course_instructor_id, c.id AS course_id
     FROM quizzes q
     JOIN lessons l ON l.id = q.lesson_id
     JOIN modules m ON m.id = l.module_id
     JOIN courses c ON c.id = m.course_id
     WHERE q.id = $1`,
    [quizId],
  );
  const quiz = rows[0];
  if (!quiz) { const e = new Error('Quiz not found'); e.httpStatus = 404; throw e; }
  if (user.role !== 'admin' && quiz.course_instructor_id !== user.id) {
    const e = new Error('You do not own the course this quiz belongs to'); e.httpStatus = 403; throw e;
  }
  return quiz;
}

// -----------------------------------------------------------------------
// GET /api/quizzes/lesson/:lessonId — quiz + questions, WITHOUT answers
// -----------------------------------------------------------------------
router.get('/lesson/:lessonId', requireAuth, async (req, res) => {
  try {
    const quizResult = await pool.query('SELECT * FROM quizzes WHERE lesson_id = $1', [req.params.lessonId]);
    const quiz = quizResult.rows[0];
    if (!quiz) return res.status(404).json({ status: 'error', message: 'No quiz found for this lesson' });

    const questionsResult = await pool.query(
      'SELECT id, prompt, options, sort_order FROM questions WHERE quiz_id = $1 ORDER BY sort_order, id',
      [quiz.id],
    );

    res.json({ status: 'ok', quiz: { ...quiz, questions: questionsResult.rows } });
  } catch (err) {
    console.error('[quiz] fetch error', err);
    res.status(500).json({ status: 'error', message: 'Could not load quiz' });
  }
});

// -----------------------------------------------------------------------
// POST /api/quizzes/:quizId/attempts — submit answers, auto-grade
// Body: { answers: { "<questionId>": <chosenOptionIndex>, ... } }
// -----------------------------------------------------------------------
router.post('/:quizId/attempts', requireAuth, async (req, res) => {
  const { quizId } = req.params;
  const { answers } = req.body || {};

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ status: 'error', message: 'answers must be an object of { questionId: chosenIndex }' });
  }

  try {
    const quizResult = await pool.query(
      `SELECT q.*, l.id AS lesson_id, m.course_id
       FROM quizzes q JOIN lessons l ON l.id = q.lesson_id JOIN modules m ON m.id = l.module_id
       WHERE q.id = $1`,
      [quizId],
    );
    const quiz = quizResult.rows[0];
    if (!quiz) return res.status(404).json({ status: 'error', message: 'Quiz not found' });

    const enrolled = await pool.query(
      'SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user.id, quiz.course_id],
    );
    if (enrolled.rows.length === 0) {
      return res.status(403).json({ status: 'error', message: 'You must be enrolled in this course first' });
    }

    const questionsResult = await pool.query(
      'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY sort_order, id',
      [quizId],
    );
    const questions = questionsResult.rows;
    if (questions.length === 0) {
      return res.status(400).json({ status: 'error', message: 'This quiz has no questions yet' });
    }

    let correctCount = 0;
    const results = questions.map((q) => {
      const chosen = answers[q.id];
      const isCorrect = Number(chosen) === q.correct_index;
      if (isCorrect) correctCount += 1;
      return {
        question_id: q.id,
        prompt: q.prompt,
        options: q.options,
        chosen_index: chosen === undefined ? null : Number(chosen),
        correct_index: q.correct_index,
        is_correct: isCorrect,
        explanation: q.explanation,
      };
    });

    const scorePercent = Math.round((correctCount / questions.length) * 100);
    const passed = scorePercent >= quiz.pass_percent;

    await pool.query(
      `INSERT INTO quiz_attempts (quiz_id, user_id, score_percent, passed, answers)
       VALUES ($1, $2, $3, $4, $5)`,
      [quizId, req.user.id, scorePercent, passed, JSON.stringify(answers)],
    );

    if (passed) {
      await pool.query(
        `INSERT INTO progress (user_id, lesson_id, completed, completed_at)
         VALUES ($1, $2, true, now())
         ON CONFLICT (user_id, lesson_id) DO UPDATE SET completed = true, completed_at = now()`,
        [req.user.id, quiz.lesson_id],
      );
    }

    const certificate = passed ? await issueCertificateIfComplete(req.user.id, quiz.course_id) : null;
    const completion = await getCourseCompletion(req.user.id, quiz.course_id);

    res.json({
      status: 'ok',
      score_percent: scorePercent,
      passed,
      pass_percent: quiz.pass_percent,
      results,
      completion,
      certificate_issued: !!certificate,
    });
  } catch (err) {
    console.error('[quiz] attempt error', err);
    res.status(500).json({ status: 'error', message: 'Could not grade quiz' });
  }
});

// -----------------------------------------------------------------------
// GET /api/quizzes/:quizId/attempts/me — this user's attempt history
// -----------------------------------------------------------------------
router.get('/:quizId/attempts/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, score_percent, passed, attempted_at FROM quiz_attempts
       WHERE quiz_id = $1 AND user_id = $2 ORDER BY attempted_at DESC`,
      [req.params.quizId, req.user.id],
    );
    res.json({ status: 'ok', attempts: rows });
  } catch (err) {
    console.error('[quiz] attempt history error', err);
    res.status(500).json({ status: 'error', message: 'Could not load attempt history' });
  }
});

// =========================================================================
// Question authoring (instructor/admin) — lets the course-creation UI
// populate the quizzes created via POST /api/courses/modules/:id/lessons
// =========================================================================

router.post('/:quizId/questions', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadQuizOwnership(req.params.quizId, req.user);
    const { prompt, options, correct_index, explanation, sort_order } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ status: 'error', message: 'prompt is required' });
    }
    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ status: 'error', message: 'options must be an array of at least 2 choices' });
    }
    if (!Number.isInteger(correct_index) || correct_index < 0 || correct_index >= options.length) {
      return res.status(400).json({ status: 'error', message: 'correct_index must be a valid index into options' });
    }

    const { rows } = await pool.query(
      `INSERT INTO questions (quiz_id, prompt, options, correct_index, explanation, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.quizId, prompt, JSON.stringify(options), correct_index, explanation || null, Number.isInteger(sort_order) ? sort_order : 0],
    );
    res.status(201).json({ status: 'ok', question: rows[0] });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ status: 'error', message: err.message });
    console.error('[quiz] question create error', err);
    res.status(500).json({ status: 'error', message: 'Could not create question' });
  }
});

router.put('/questions/:questionId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    const { rows: qRows } = await pool.query('SELECT quiz_id FROM questions WHERE id = $1', [req.params.questionId]);
    if (!qRows[0]) return res.status(404).json({ status: 'error', message: 'Question not found' });
    await loadQuizOwnership(qRows[0].quiz_id, req.user);

    const { prompt, options, correct_index, explanation, sort_order } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    if (prompt !== undefined) { fields.push(`prompt = $${i++}`); values.push(prompt); }
    if (options !== undefined) { fields.push(`options = $${i++}`); values.push(JSON.stringify(options)); }
    if (correct_index !== undefined) { fields.push(`correct_index = $${i++}`); values.push(correct_index); }
    if (explanation !== undefined) { fields.push(`explanation = $${i++}`); values.push(explanation); }
    if (sort_order !== undefined) { fields.push(`sort_order = $${i++}`); values.push(sort_order); }
    if (fields.length === 0) return res.status(400).json({ status: 'error', message: 'No updatable fields provided' });

    values.push(req.params.questionId);
    const { rows } = await pool.query(`UPDATE questions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
    res.json({ status: 'ok', question: rows[0] });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ status: 'error', message: err.message });
    console.error('[quiz] question update error', err);
    res.status(500).json({ status: 'error', message: 'Could not update question' });
  }
});

router.delete('/questions/:questionId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    const { rows: qRows } = await pool.query('SELECT quiz_id FROM questions WHERE id = $1', [req.params.questionId]);
    if (!qRows[0]) return res.status(404).json({ status: 'error', message: 'Question not found' });
    await loadQuizOwnership(qRows[0].quiz_id, req.user);
    await pool.query('DELETE FROM questions WHERE id = $1', [req.params.questionId]);
    res.json({ status: 'ok' });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ status: 'error', message: err.message });
    console.error('[quiz] question delete error', err);
    res.status(500).json({ status: 'error', message: 'Could not delete question' });
  }
});

export default router;
